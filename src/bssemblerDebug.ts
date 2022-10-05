/*
 * bssemblerDebug.ts implements the Debug Adapter Protocol (DAP) used by the client (e.g. VS Code)
 *
 * The most important class of the Debug Adapter is the BssemblerDebugSession which implements many DAP requests.
 */

import * as vscode from 'vscode';
import {
    Breakpoint, Logger, logger,
    LoggingDebugSession,
    InitializedEvent, Scope, Handles, Thread, StoppedEvent,
    StackFrame, Source, TerminatedEvent, BreakpointEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { BssemblerRuntime, FileAccessor, RuntimeBreakpoint } from './bssemblerRuntime';
import { Subject } from 'await-notify';
import { basename } from 'path';

/**
 * This interface describes the bssembler-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the bssembler-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** An absolute path to the "program" to debug. */
    program: string;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** enable logging the Debug Adapter Protocol */
    trace?: boolean;
    /** run without debugging */
    noDebug?: boolean;
    /** run without emulator graphics */
    noGraphics?: boolean
    /** Command with arguments for external bssembler. */
    bssemblerCommand?: string;
    /** Command with arguments for external. */
    emulatorCommand?: string;
}

// Not supporting attach currently.
// interface IAttachRequestArguments extends ILaunchRequestArguments { }

export class BssemblerDebugSession extends LoggingDebugSession {
    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static threadID = 1;

    private _runtime: BssemblerRuntime;

    private _configurationDone = new Subject();

    private _variableHandles = new Handles<'registers'>();

    private _channel?: vscode.OutputChannel;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor(fileAccessor: FileAccessor, channel?: vscode.OutputChannel) {
        super();

        // this debugger uses zero-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(false);

        this._channel = channel;
        this._channel?.clear();

        this._runtime = new BssemblerRuntime(fileAccessor);

        this._runtime.on('breakpoint-changed', (breakpoint: RuntimeBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', {
                id: breakpoint.id, line: breakpoint.line, verified: true,
            } as DebugProtocol.Breakpoint));
        });

        this._runtime.on('breakpoint-removed', (breakpoint: RuntimeBreakpoint) => {
            this.sendEvent(new BreakpointEvent('removed', { id: breakpoint.id } as DebugProtocol.Breakpoint));
        });

        this._runtime.on('stop-on-breakpoint', _ =>
            this.sendEvent(new StoppedEvent('breakpoint', BssemblerDebugSession.threadID)));

        this._runtime.on('stop-on-step', _ =>
            this.sendEvent(new StoppedEvent('step', BssemblerDebugSession.threadID)));

        this._runtime.on('stop-on-pause', _ =>
            this.sendEvent(new StoppedEvent('entry', BssemblerDebugSession.threadID)));

        this._runtime.on('emulator-stopped', _ =>
            this.sendEvent(new TerminatedEvent(false)));

        this._runtime.on('error-on-start', error => {
            this.sendEvent(new TerminatedEvent(false));
            vscode.window.showErrorMessage(`Could not Launch Debugger: ${error}`);
        });

        this._runtime.on('log', line => this._channel?.appendLine(line));
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        response.body.supportTerminateDebuggee = true;

        this.sendResponse(response);

        // since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected async launchRequest(_response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        // wait 1 second until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        // start the program in the runtime
        await this._runtime.start(args.program, !!args.stopOnEntry, !args.noDebug, !!args.noGraphics, args.bssemblerCommand, args.emulatorCommand);
    }

    protected terminateRequest(response: DebugProtocol.TerminateResponse, args: DebugProtocol.TerminateArguments, request?: DebugProtocol.Request) {
        this._runtime.terminate();
        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): void {
        if (args.terminateDebuggee) {
            this._runtime.terminate();
        }
        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        response.body = {
            scopes: [
                new Scope("Registers", this._variableHandles.create('registers'), false)
            ]
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = {
            threads: [
                new Thread(BssemblerDebugSession.threadID, "Main Thread"),
            ]
        };
        this.sendResponse(response);
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        const path = args.source.path as string;
        const clientLines = args.lines || [];

        const debuggerLines = clientLines.map(line => this.convertClientLineToDebugger(line));
        const debuggerBreakpoints = await this._runtime.setBreakpoints(path, debuggerLines);
        const breakpoints = debuggerBreakpoints.map((debuggerBreakpoint) => {
            const line = this.convertDebuggerLineToClient(debuggerBreakpoint.line);
            const breakpoint = new Breakpoint(true, line);
            breakpoint.setId(debuggerBreakpoint.id);
            return breakpoint;
        });

        response.body = { breakpoints };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._runtime.continue();
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this._runtime.step();
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        const location = this._runtime.getCurrentLocation();
        response.body = {
            stackFrames: [
                new StackFrame(0, "Position", this.createSource(location.path), location.line),
            ],
            totalFrames: 1,
        };
        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
        const handle = this._variableHandles.get(args.variablesReference);
        if (handle !== 'registers') {
            return;
        }

        response.body = {
            variables: this._runtime.getRegisters().map((value, index) => ({
                name: `R${index}`,
                value: `${value}`,
                variablesReference: 0,
                type: 'integer',
            } as DebugProtocol.Variable))
        };
        this.sendResponse(response);
    }

    private createSource(filePath: string): Source {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
    }
}
