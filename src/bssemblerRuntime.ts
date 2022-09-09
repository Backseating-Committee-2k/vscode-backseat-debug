import { EventEmitter } from 'events';
import { spawn } from 'child_process';

export interface FileAccessor {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, contents: Uint8Array): Promise<void>;
    extensionPath(path: string): string;
}

export class BssemblerRuntime extends EventEmitter {
    constructor(private _fileAccessor: FileAccessor) {
        super();
    }

    /**
     * Start executing the given program.
     */
    public async start(program: string, stopOnEntry: boolean, debug: boolean): Promise<void> {
        const path = this._fileAccessor.extensionPath('./bin/debug-emulator.exe');
        const debugEmulator = spawn(path);

        debugEmulator.stdout.on('data', data => {
            console.log(data);
        });

        debugEmulator.on('exit', _code => {
            console.log('closed');
        });

        console.log('spawned');
    }
}
