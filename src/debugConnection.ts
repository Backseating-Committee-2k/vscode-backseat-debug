import { EventEmitter } from 'events';
import { Socket, createConnection } from 'net';

export interface Breakpoints {
    locations: number[];
}

export type Request = StartExecution | Continue | StepOne |
    SetBreakpoints | RemoveBreakpoints | SetRegister | Terminate;
export type Address = number;

export class StartExecution {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    constructor(public readonly stop_on_entry: boolean) { }
}

export class SetBreakpoints {
    // @ts-ignore Suppressing invalid "declared but never used". All fields are used by JSON.stringify.
    constructor(private readonly locations: Address[]) { }
}

export class RemoveBreakpoints {
    // @ts-ignore Suppressing invalid "declared but never used". All fields are used by JSON.stringify.
    constructor(private readonly locations: Address[]) { }
}

export class SetRegister {
    constructor(public readonly register: number, public readonly value: number) { }
}

export class Continue { }
export class StepOne { }
export class Terminate { }

export type Response = HitBreakpoint | Breaking | Pausing | Registers;

export class HitBreakpoint {
    constructor(public readonly location: Address) { }
}

export class Breaking {
    constructor(public readonly location: Address) { }
}

export class Pausing {
    constructor(public readonly location: Address) { }
}

export class Registers {
    constructor(public readonly registers: number[]) { }
}

export class DebugConnection extends EventEmitter {
    private receiveBuffer = '';
    private client?: Socket;

    public static connect(port: number): Promise<DebugConnection> {
        return new Promise((resolve, reject) => {
            let connected = false;
            const debugConnection = new DebugConnection();
            const client = createConnection({ port }, () => {
                connected = true;
                resolve(debugConnection);
            });

            debugConnection.client = client;

            client.on('error', error => {
                if (!connected) { reject(error); }
                debugConnection.clientError(error);
            });

            client.on('data', data => debugConnection.clientData(data));
        });
    }

    public send(request: Request) {
        const name = request.constructor.name;
        const stringifiedRequest = JSON.stringify({ [name]: request });
        this.client?.write(`${stringifiedRequest}\0`, 'utf8');
    }

    private clientError(error: Error) {
        this.sendEvent('error', error);
    }

    private clientData(data: Buffer) {
        let index = data.indexOf(0);
        if (index < 0) {
            this.receiveBuffer += data.toString('utf8');
            return;
        }

        if (index > 0) {
            this.receiveBuffer += data.toString('utf8', 0, index);
        }
        this.receivedMessage(this.receiveBuffer);
        this.receiveBuffer = '';

        while (true) {
            const start = index + 1;
            index = data.indexOf(0, start);

            if (index < 0) {
                this.receiveBuffer = data.toString('utf8', start);
                break;
            }

            const chunk = data.toString('utf8', start, index);
            this.receivedMessage(chunk);
        }
    }

    private receivedMessage(message: string) {
        const json = JSON.parse(message);
        const events = [
            'HitBreakpoint',
            'Breakpoints',
            'Breaking',
            'Pausing',
            'Registers',
        ];
        for (const event of events) {
            if (json.hasOwnProperty(event)) {
                this.sendEvent(`message-${event.toLowerCase()}`, json[event]);
            }
        }
    }

    private sendEvent(event: string, ...args: any[]): void {
        setTimeout(() => {
            this.emit(event, ...args);
        }, 0);
    }
}
