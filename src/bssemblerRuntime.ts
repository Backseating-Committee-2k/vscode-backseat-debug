import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { file as tmpFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { readFile } from 'fs/promises';
import { Breaking, Continue, DebugConnection, HitBreakpoint, RemoveBreakpoints, SetBreakpoints, StartExecution, StepOne } from './debugConnection';

export interface FileAccessor {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, contents: Uint8Array): Promise<void>;
    extensionPath(path: string): string;
}

const LOCAL_BSSEMBLER_PATH = './bin/Upholsterer2k.exe';
const BSSEMBLE_TIMEOUT_MS = 2500;

export class RuntimeBreakpoint {
    constructor(public readonly id: number, public readonly line: number) { }
}

class RuntimeBreakpoints {
    public readonly items = new Map<number, RuntimeBreakpoint>();
}

export class RuntimeLocation {
    constructor(public readonly path: string, public readonly line: number) { }
}

class LineToInstructionMapper {
    private readonly lineToInstruction = new Map<number, number>();
    private readonly instructionToLine = new Map<number, number>();
    private readonly lines = new Array<number>();

    public set(line: number, instruction: number) {
        this.lineToInstruction.set(line, instruction);
        this.instructionToLine.set(instruction, line);
        this.lines.push(line);
        this.lines.sort();
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

    public clear() {
        this.lineToInstruction.clear();
        this.instructionToLine.clear();
        this.lines.splice(0, this.lines.length);
    }
}

export class BssemblerRuntime extends EventEmitter {
    private readonly breakpoints = new Map<string, RuntimeBreakpoints>();
    private nextBreakpointId = 0;

    private lineMapper = new LineToInstructionMapper();

    private currentProgram?: string;
    private currentLine: number = 0;
    private debugConnection?: DebugConnection;

    constructor(private _fileAccessor: FileAccessor) {
        super();
    }

    public async setBreakpoints(path: string, breakpointLines: number[]): Promise<RuntimeBreakpoint[]> {
        // TODO: Send breakpoint updates to runtime if called while running.

        path = this.normalisePathAndCasing(path);
        let oldBreakpoints = this.breakpoints.get(path) || new RuntimeBreakpoints();

        let newBreakpoints = new RuntimeBreakpoints();
        for (const line of breakpointLines) {
            if (newBreakpoints.items.has(line)) {
                continue; // Ignore duplicate lines.
            }

            let breakpoint = oldBreakpoints.items.get(line);
            if (!breakpoint) {
                breakpoint = new RuntimeBreakpoint(this.nextBreakpointId, line);
                ++this.nextBreakpointId;
            } else {
                oldBreakpoints.items.delete(line);
            }

            newBreakpoints.items.set(line, breakpoint);
        }

        this.sendBreakpointUpdates(this.debugConnection, newBreakpoints.items.values(), oldBreakpoints.items.values());

        this.breakpoints.set(path, newBreakpoints);

        return [...newBreakpoints.items.values()];
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

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
        program = this.normalisePathAndCasing(program);
        this.currentProgram = program;
        this.lineMapper = new LineToInstructionMapper();

        const { fd: _backseatFd, path: backseatPath, cleanup: cleanupBackseat } = await tmpFile();
        const { fd: _mapFd, path: mapFilePath, cleanup: cleanupMapFile } = await tmpFile();

        try {
            await this.bssemble(program, backseatPath, mapFilePath);
            await this.readMapFile(mapFilePath);
            const debugConnection = await DebugConnection.connect();
            this.listenToConnectionEvents(debugConnection);
            this.initialiseDebugger(debugConnection, stopOnEntry);
            this.debugConnection = debugConnection;
        } catch (error) {
            // TODO: Show errors to the user
            console.log(error);
        } finally {
            cleanupMapFile();
            cleanupBackseat();
        }
    }

    private async bssemble(program: string, backseatPath: string, mapFilePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const bssemblerPath = this._fileAccessor.extensionPath(LOCAL_BSSEMBLER_PATH);
            const bssemblerProcess = spawn(bssemblerPath, ['-m', mapFilePath, program]);

            const backseatStream = createWriteStream(backseatPath);
            bssemblerProcess.stdout.pipe(backseatStream);

            let killed = false;

            const timer = setTimeout(() => {
                killed = true;
                bssemblerProcess.kill();
                backseatStream.close();
                reject(new Error('bssembler process timed out'));
            }, BSSEMBLE_TIMEOUT_MS);

            bssemblerProcess.on('close', code => {
                if (!killed) {
                    clearTimeout(timer);
                    backseatStream.close();
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error('bssembler returned non-zero exit code'));
                    }
                }
            });
        });
    }

    private async readMapFile(mapFilePath: string) {
        this.lineMapper.clear();
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
    }

    private listenToConnectionEvents(debugConnection: DebugConnection) {
        debugConnection.on('message-hitbreakpoint', (event: HitBreakpoint) => {
            const line = this.lineMapper.convertInstructionToLine(event.location);
            const breakpoints = this.breakpoints.get(this.currentProgram ?? '');

            if (!line || !this.currentProgram || !breakpoints) {
                return;
            }

            this.currentLine = line;
            const breakpoint = breakpoints.items.get(line);

            if (breakpoint) {
                this.sendEvent('stop-on-breakpoint', breakpoint);
            }
        });

        debugConnection.on('message-breaking', (event: Breaking) => {
            const line = this.lineMapper.convertInstructionToLine(event.location);
            if (line) {
                this.currentLine = line;
                this.sendEvent('stop-on-step', line);
            }
        });
    }

    private initialiseDebugger(debugConnection: DebugConnection, stopOnEntry: boolean) {
        const breakpoints = this.breakpoints.get(this.currentProgram ?? '');
        if (this.currentProgram && breakpoints) {
            this.sendBreakpointUpdates(debugConnection, breakpoints.items.values(), undefined);
        }

        debugConnection.send(new StartExecution());
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
