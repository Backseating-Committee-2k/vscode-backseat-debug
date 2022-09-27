import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { file as tmpFile } from 'tmp-promise';
import { createWriteStream } from 'fs';
import { readFile } from 'fs/promises';
import { DebugConnection, SetBreakpoints } from './debugConnection';

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
}

export class BssemblerRuntime extends EventEmitter {
    private readonly breakpoints = new Map<string, RuntimeBreakpoints>();
    private nextBreakpointId = 0;

    private lineMapper = new LineToInstructionMapper();

    private currentProgram?: string;
    private debugConnection?: DebugConnection;

    constructor(private _fileAccessor: FileAccessor) {
        super();
    }

    public async setBreakpoints(path: string, breakpointLines: number[]): Promise<RuntimeBreakpoint[]> {
        // TODO: Send breakpoint updates to runtime if called while running.

        path = this.normalisePathAndCasing(path);
        let breakpoints = this.breakpoints.get(path) || new RuntimeBreakpoints();

        let newBreakpoints = new RuntimeBreakpoints();
        for (const line of breakpointLines) {
            if (newBreakpoints.items.has(line)) {
                continue; // Ignore duplicate lines.
            }

            let breakpoint = breakpoints.items.get(line);
            if (!breakpoint) {
                breakpoint = new RuntimeBreakpoint(this.nextBreakpointId, line);
                ++this.nextBreakpointId;
            } else {
                breakpoints.items.delete(line);
            }

            newBreakpoints.items.set(line, breakpoint);
        }

        // TODO: Notify delete
        // for (const [line, breakpoint] of breakpoints.items.entries()) {

        // }

        this.breakpoints.set(path, newBreakpoints);

        return [...newBreakpoints.items.values()];
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
            this.debugConnection = await DebugConnection.connect();
            this.initialiseDebugger(stopOnEntry);
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
            let killed = false;

            const bssemblerPath = this._fileAccessor.extensionPath(LOCAL_BSSEMBLER_PATH);
            const bssemblerProcess = spawn(bssemblerPath, ['-m', mapFilePath, program]);

            const backseatStream = createWriteStream(backseatPath);
            bssemblerProcess.stdout.pipe(backseatStream);

            bssemblerProcess.on('close', code => {
                if (!killed) {
                    backseatStream.close();
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error('bssembler returned non-zero exit code'));
                    }
                }
            });

            setTimeout(() => {
                killed = true;
                bssemblerProcess.kill();
                backseatStream.close();
                reject(new Error('bssembler process timed out'));
            }, BSSEMBLE_TIMEOUT_MS);
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
    }

    private initialiseDebugger(stopOnEntry: boolean) {
        const breakpoints = this.breakpoints.get(this.currentProgram ?? '');
        if (this.currentProgram && breakpoints) {
            const instructionBreakpoints: number[] = [];
            for (const line of breakpoints.items.keys()) {
                const instruction = this.lineMapper.convertLineToInstruction(line);
                if (instruction) {
                    // TODO: Verify breakpoints and move them down if possible.
                    instructionBreakpoints.push(instruction ?? 0);
                }
            }

            this.debugConnection?.send(new SetBreakpoints(instructionBreakpoints));
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
