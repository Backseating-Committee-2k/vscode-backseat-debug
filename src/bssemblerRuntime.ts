import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { file as tmpFile } from 'tmp-promise';
import { createWriteStream } from 'fs';

export interface FileAccessor {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, contents: Uint8Array): Promise<void>;
    extensionPath(path: string): string;
}

const LOCAL_BSSEMBLER_PATH = './bin/Upholsterer2k.exe';
const BSSEMBLE_TIMEOUT_MS = 2500;

export class BssemblerRuntime extends EventEmitter {
    constructor(private _fileAccessor: FileAccessor) {
        super();
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
        const { fd: _backseatFd, path: backseatPath, cleanup: cleanupBackseat } = await tmpFile();
        const { fd: _mapFd, path: mapFilePath, cleanup: cleanupMapFile } = await tmpFile();

        try {
            await this.bssemble(program, backseatPath, mapFilePath);
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
}
