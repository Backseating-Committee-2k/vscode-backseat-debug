import { EventEmitter } from 'events';
import { ChildProcess, exec, ExecOptions, spawn } from 'child_process';
import { file as tmpFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { readFile } from 'fs/promises';
import { Breaking, Continue, DebugConnection, Hello, HitBreakpoint, Pausing, BreakState, RemoveBreakpoints, SetBreakpoints, SetRegister, StartExecution, StepOne, Terminate } from './debugConnection';
import { Readable } from 'stream';
import { TextDecoder } from 'util';

export interface FileAccessor {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, contents: Uint8Array): Promise<void>;
    extensionPath(path: string): string;
}

export interface Configuration {
    bssemblerPath: string,
    emulatorPath: string,
    emulatorPathNoGraphics: string,
    bssemblerCommand: string,
    emulatorCommand: string,
    bssemblerTimeout: number,
    emulatorTimeout: number,
}

const LOCAL_BSSEMBLER_PATH = './bin/Upholsterer2k.exe';
const LOCAL_EMULATOR_PATH = './bin/backseat_safe_system_2k.exe';
const LOCAL_EMULATOR_NO_GRAPHICS_PATH = './bin/backseat_safe_system_2k_no_graphics.exe';
const LOCAL_FONT_FILE_PATH = './bin/CozetteVector.ttf';
const DEBUGGER_PORT_PREFIX = 'Debugger-Port:';

export class RuntimeBreakpoint {
    constructor(public readonly id: number, public readonly line: number) { }
}

class RuntimeBreakpoints {
    public readonly items = new Map<number, RuntimeBreakpoint>();
}

export class RuntimeLocation {
    constructor(public readonly path: string, public readonly line?: number) { }
}

export class RuntimeStackFrame {
    constructor(public readonly line?: number, public readonly name?: string) { }
}

class LineToInstructionMapper {
    private readonly lineToInstruction = new Map<number, number>();
    private readonly instructionToLine = new Map<number, number>();
    private readonly lines = new Array<number>();

    public set(line: number, instruction: number) {
        this.lineToInstruction.set(line, instruction);
        this.instructionToLine.set(instruction, line);
        this.lines.push(line);
        this.lines.sort((a, b) => a - b);
    }

    public convertLineToInstruction(line: number): number | undefined {
        return this.lineToInstruction.get(line);
    }

    public convertInstructionToLine(instruction: number): number | undefined {
        return this.instructionToLine.get(instruction);
    }

    public getNextValidLine(line: number): number | undefined {
        // Could be optimised using a binary search.
        for (let i = 0; i < this.lines.length; ++i) {
            if (this.lines[i] >= line) {
                return this.lines[i];
            }
        }

        return undefined;
    }
}

export class BssemblerRuntime extends EventEmitter {
    private readonly breakpoints = new Map<string, RuntimeBreakpoints>();

    private lineMapper = new LineToInstructionMapper();
    private linesLoaded = false;

    private currentProgram?: string;
    private currentLines?: string[];
    private currentLine?: number;
    private registers: number[] = [];
    private callStack: number[] = [];

    private debugConnection?: DebugConnection;
    private emulatorProcess?: ChildProcess;
    private emulatorPid?: number;

    constructor(private configuration: Configuration, private fileAccessor: FileAccessor) {
        super();
    }

    public setBreakpoints(path: string, breakpoints: RuntimeBreakpoint[]) {
        path = this.normalisePathAndCasing(path);
        const removedBreakpoints = this.breakpoints.get(path) || new RuntimeBreakpoints();
        const newBreakpoints = new RuntimeBreakpoints();

        for (const breakpoint of breakpoints) {
            if (newBreakpoints.items.has(breakpoint.line)) {
                this.sendEvent('breakpoint-removed', breakpoint);
            } else {
                newBreakpoints.items.set(breakpoint.line, breakpoint);
            }
        }
        this.breakpoints.set(path, newBreakpoints);

        if (this.linesLoaded) {
            this.validateBreakpoints();
        }

        const validatedNewBreakpoints = this.breakpoints.get(path) || new RuntimeBreakpoints();
        const addedBreakpoints = new RuntimeBreakpoints();

        for (const breakpoint of validatedNewBreakpoints.items.values()) {
            if (removedBreakpoints.items.has(breakpoint.line)) {
                removedBreakpoints.items.delete(breakpoint.line);
            } else {
                addedBreakpoints.items.set(breakpoint.line, breakpoint);
            }
        }

        this.sendBreakpointUpdates(this.debugConnection, addedBreakpoints.items.values(), removedBreakpoints.items.values());
    }

    public continue() {
        this.debugConnection?.send(new Continue());
    }

    public step() {
        this.debugConnection?.send(new StepOne());
    }

    public getCurrentLocation(): RuntimeLocation {
        return new RuntimeLocation(this.currentProgram ?? '', this.currentLine);
    }

    public getCallStack(): RuntimeStackFrame[] {
        return [
            ...this.callStack.map(location => {
                const line = this.lineMapper.convertInstructionToLine(location);
                const label = this.getCallLabel(line);
                return new RuntimeStackFrame(line, label);
            }),
            new RuntimeStackFrame(this.currentLine),
        ];
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean, debug: boolean, noGraphics: boolean, bssemblerCommand?: string, emulatorCommand?: string): Promise<void> {
        bssemblerCommand = bssemblerCommand || this.configuration.bssemblerCommand;
        emulatorCommand = emulatorCommand || this.configuration.emulatorCommand;
        const hasExternalBssembler = !!bssemblerCommand || !!this.configuration.bssemblerPath;
        const hasExternalEmulator = !!emulatorCommand || !!this.configuration.emulatorPath;

        if ((process.platform !== 'win32' || process.arch !== 'x64') && (!hasExternalBssembler || !hasExternalEmulator)) {
            this.sendEvent('error-on-start', '"bssemblerCommand" and "emulatorCommand" have to be defined in launch.json for platforms other than windows/x64');
            return;
        }

        program = this.normalisePathAndCasing(program);
        this.currentProgram = program;
        this.lineMapper = new LineToInstructionMapper();

        const { fd: _backseatFd, path: backseatPath, cleanup: cleanupBackseat } = await tmpFile();
        const { fd: _mapFd, path: mapFilePath, cleanup: cleanupMapFile } = await tmpFile();

        try {
            const programContent = this.fileAccessor.readFile(program);
            await this.bssemble(program, backseatPath, mapFilePath, bssemblerCommand);
            await this.readMapFile(mapFilePath);
            this.validateBreakpoints();
            const port = await this.startEmulator(backseatPath, noGraphics, emulatorCommand);
            const debugConnection = await DebugConnection.connect(port);
            this.listenToConnectionEvents(debugConnection);
            this.initialiseDebugger(debugConnection, stopOnEntry);
            this.debugConnection = debugConnection;
            this.currentLines = this.decodeSource(await programContent);
        } catch (error) {
            this.terminate();
            this.emulatorProcess = undefined;
            this.sendEvent('log', `[error] ${error}`);
            this.sendEvent('error-on-start', error);
            console.error(error);
        } finally {
            cleanupMapFile();
            cleanupBackseat();
        }
    }

    public terminate() {
        this.debugConnection?.send(new Terminate());
        setTimeout(() => this.emulatorProcess?.kill(), 100);
        setTimeout(() => this.emulatorPid ? process.kill(this.emulatorPid) : {}, 100);
    }

    public getRegisters(): number[] {
        return [...this.registers];
    }

    public setRegister(name: string, value: number): boolean {
        const index = this.matchRegister(name);
        if (index === false) {
            return false;
        }

        this.debugConnection?.send(new SetRegister(index, value));
        return !!this.debugConnection;
    }

    private async bssemble(program: string, backseatPath: string, mapFilePath: string, bssemblerCommand?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            let bssemblerProcess: ChildProcess;

            if (!bssemblerCommand) {
                const bssemblerPath = this.configuration.bssemblerPath ||
                    this.fileAccessor.extensionPath(LOCAL_BSSEMBLER_PATH);
                bssemblerProcess = this.spawn(bssemblerPath, ['-m', mapFilePath, program]);

            } else {
                bssemblerProcess = this.exec(`${bssemblerCommand} -m "${mapFilePath}" "${program}"`, { encoding: 'buffer' });
            }

            const backseatStream = createWriteStream(backseatPath);
            bssemblerProcess.stdout?.pipe(backseatStream);
            this.streamLines(bssemblerProcess.stderr, line => this.sendEvent('log', `[bssembler] ${line}`));

            let killed = false;

            const timer = setTimeout(() => {
                killed = true;
                bssemblerProcess.kill();
                backseatStream.close();
                reject(new Error('bssembler process timed out'));
            }, this.configuration.bssemblerTimeout);

            bssemblerProcess.on('close', code => {
                if (killed) {
                    return;
                }

                clearTimeout(timer);
                backseatStream.close();
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('bssembler returned non-zero exit code'));
                }
            });
        });
    }

    private async readMapFile(mapFilePath: string) {
        const contents = await readFile(mapFilePath, 'ascii');
        const lines = contents.split(/[\r\n]+/);
        lines.shift(); // Skip first line.

        for (const fileLine of lines) {
            if (fileLine.trim().length === 0) {
                continue;
            }
            const [line, instruction, ...rest] = fileLine.split(/\s+/).map(s => parseInt(s));

            if (isNaN(line) || isNaN(instruction) || rest.length > 0) {
                throw new Error(`Mapping file contains invalid line "${fileLine}"`);
            }

            this.lineMapper.set(line, instruction);
        }

        this.linesLoaded = true;
    }

    private validateBreakpoints() {
        const breakpoints = this.breakpoints.get(this.currentProgram || '');
        if (!this.currentProgram || !breakpoints) {
            return;
        }

        for (const breakpoint of [...breakpoints.items.values()]) {
            const correctLine = this.lineMapper.getNextValidLine(breakpoint.line);
            if (!correctLine || (correctLine !== breakpoint.line && breakpoints.items.has(correctLine))) {
                this.sendEvent('breakpoint-removed', breakpoint);
                breakpoints.items.delete(breakpoint.line);
            } else if (correctLine !== breakpoint.line) {
                breakpoints.items.delete(breakpoint.line);
                const newBreakpoint = new RuntimeBreakpoint(breakpoint.id, correctLine);
                breakpoints.items.set(correctLine, newBreakpoint);
                this.sendEvent('breakpoint-changed', newBreakpoint);
            }
        }
    }

    private getEmulatorPath(noGraphics: boolean): string {
        let configuredPath = noGraphics ? this.configuration.emulatorPathNoGraphics : this.configuration.emulatorPath;
        if (noGraphics && this.configuration.emulatorPath && !this.configuration.emulatorPathNoGraphics) {
            configuredPath = this.configuration.emulatorPath;
            this.sendEvent('log', '[warning] Configuration contains external emulator path, but no path to external emulator without graphics. Using external emulator with graphics.');
        }

        return configuredPath ||
            this.fileAccessor.extensionPath(noGraphics ? LOCAL_EMULATOR_NO_GRAPHICS_PATH : LOCAL_EMULATOR_PATH);
    }

    private async startEmulator(backseatPath: string, noGraphics: boolean, emulatorCommand?: string): Promise<number> {
        return new Promise((resolve, reject) => {
            if (!emulatorCommand) {
                const emulatorPath = this.getEmulatorPath(noGraphics);
                const fontPath = this.fileAccessor.extensionPath(LOCAL_FONT_FILE_PATH);
                this.emulatorProcess = this.spawn(emulatorPath, ['debug', '--font-path', fontPath, backseatPath]);
            } else {
                this.emulatorProcess = this.exec(`${emulatorCommand} "${backseatPath}"`);
            }

            let killed = false;

            const timer = setTimeout(() => {
                killed = true;
                this.emulatorProcess?.kill();
                reject(new Error('timed out on waiting for debugger port'));
            }, this.configuration.emulatorTimeout);

            this.emulatorProcess.on('close', code => {
                reject(new Error('emulator stopped unexpectedly')); // reject if still waiting for port
                this.sendEvent('emulator-stopped', code);
            });

            this.streamLines(this.emulatorProcess.stderr, line => this.sendEvent('log', `[emulator] ${line}`));

            this.streamLines(this.emulatorProcess.stdout, line => {
                this.sendEvent('log', `[emulator] ${line}`);
                if (killed || !line.startsWith(DEBUGGER_PORT_PREFIX)) {
                    return;
                }

                const port = parseInt(line.substring(DEBUGGER_PORT_PREFIX.length).trim());
                if (port > 0) {
                    clearTimeout(timer);
                    resolve(port);
                } else {
                    killed = true;
                    this.emulatorProcess?.kill();
                    reject(new Error('emulator returned invalid debugger port'));
                }
            });
        });
    }

    private listenToConnectionEvents(debugConnection: DebugConnection) {
        debugConnection.on('message-hello', (event: Hello) => {
            this.emulatorPid = event.pid;
        });

        debugConnection.on('message-hitbreakpoint', (event: HitBreakpoint) => {
            this.breakAtLocation(event.location, 'stop-on-breakpoint');
        });

        debugConnection.on('message-breaking', (event: Breaking) => {
            this.breakAtLocation(event.location, 'stop-on-step');
        });

        debugConnection.on('message-pausing', (event: Pausing) => {
            this.breakAtLocation(event.location, 'stop-on-pause');
        });

        debugConnection.on('message-breakstate', (event: BreakState) => {
            this.registers = event.registers;
            this.callStack = event.call_stack;
        });
    }

    private breakAtLocation(location: number, event: string) {
        const line = this.lineMapper.convertInstructionToLine(location);
        if (!line) {
            this.sendEvent('log', `[debugger] breaking at unknown location: ${location}`);
        }
        this.currentLine = line;
        this.sendEvent(event);
    }

    private initialiseDebugger(debugConnection: DebugConnection, stopOnEntry: boolean) {
        const breakpoints = this.breakpoints.get(this.currentProgram ?? '');
        if (this.currentProgram && breakpoints) {
            this.sendBreakpointUpdates(debugConnection, breakpoints.items.values(), undefined);
        }

        debugConnection.send(new StartExecution(stopOnEntry));
    }

    private sendBreakpointUpdates(debugConnection?: DebugConnection, setBreakpoints?: IterableIterator<RuntimeBreakpoint>, removeBreakpoints?: IterableIterator<RuntimeBreakpoint>) {
        const extracAddresses = (breakpoints?: IterableIterator<RuntimeBreakpoint>) => {
            const addresses: number[] = [];
            for (const breakpoint of breakpoints ?? []) {
                const address = this.lineMapper.convertLineToInstruction(breakpoint.line);
                if (address) {
                    addresses.push(address);
                }
            }
            return addresses;
        };

        const set = extracAddresses(setBreakpoints);
        if (set.length > 0) {
            debugConnection?.send(new SetBreakpoints(set));
        }

        const remove = extracAddresses(removeBreakpoints);
        if (remove.length > 0) {
            debugConnection?.send(new RemoveBreakpoints(remove));
        }
    }

    private spawn(command: string, args?: readonly string[]): ChildProcess {
        this.sendEvent('log', `[debugger] spawn: "${command}" with ${JSON.stringify(args)}`);
        this.sendEvent('log', `    for console: "${command}" ${args?.join(' ')}`);
        return spawn(command, args);
    }

    private exec(command: string, options?: { encoding: "buffer" | null } & ExecOptions): ChildProcess {
        this.sendEvent('log', `[debugger] exec: ${command}`);
        if (options) {
            return exec(command, options);
        } else {
            return exec(command);
        }
    }

    private streamLines(stream: Readable | null, lineCallback: (line: string) => void) {
        let buffer = '';
        stream?.on('data', (chunk: Buffer) => {
            const newData = chunk.toString('utf8');
            const lines = newData.split(/[\r\n]+/);

            if (lines.length > 1) {
                const message = buffer + lines[0];
                buffer = '';
                setTimeout(() => lineCallback(message), 0);
            }

            for (let i = 1; i < lines.length - 1; ++i) {
                const message = lines[i];
                setTimeout(() => lineCallback(message), 0);
            }

            buffer = lines[lines.length - 1];
        });

        stream?.on('end', () => {
            if (buffer.length > 0) {
                setTimeout(() => lineCallback(buffer), 0);
            }
        });
    }

    private matchRegister(register: string): number | false {
        const match = register.match(/^R(0|[1-9][0-9]*)$/i);
        return match ? parseInt(match[1]) : false;
    }

    private decodeSource(content: Uint8Array): string[] {
        // Adding empty line at the beginning, because lines are indexed starting at 1.
        return ['', ...new TextDecoder().decode(content).split(/\r?\n/)];
    }

    private getCallLabel(line: number | undefined): string | undefined {
        if (!line || !this.currentLines) {
            return undefined;
        }

        if (line >= this.currentLines.length) {
            return undefined;
        }

        let instruction = this.currentLines[line].trim();

        // Remove comment from line.
        const commentIndex = instruction.indexOf('//');
        if (commentIndex >= 0) {
            instruction = instruction.substring(0, commentIndex).trim();
        }

        if (!instruction.toLowerCase().startsWith('call ')) {
            return undefined;
        }

        let label = instruction.substring('call '.length).trim();

        // Filter out CallRegister and CallPointer opcodes.
        if (this.matchRegister(label) !== false) {
            return undefined;
        }

        // Demangle backseat function names.
        const match = label.match(/^\$"::(.*)"$/);
        if (match) {
            label = match[1];
        }

        return label;
    }

    private sendEvent(event: string, ...args: any[]): void {
        setTimeout(() => {
            this.emit(event, ...args);
        }, 0);
    }

    private normalisePathAndCasing(path: string) {
        if (process.platform === 'win32') {
            return path.replace(/\//g, '\\').toLowerCase();
        } else {
            return path.replace(/\\/g, '/');
        }
    }
}
