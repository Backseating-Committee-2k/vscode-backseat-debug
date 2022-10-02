'use strict';

import { TextEncoder } from 'util';
import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import { BssemblerDebugSession } from './bssemblerDebug';
import { FileAccessor } from './bssemblerRuntime';

export function activateDebug(context: vscode.ExtensionContext) {
    registerCommands(context);

    const factory: any = new InlineDebugAdapterFactory(context);
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('bssembler', factory));
    if ('dispose' in factory) {
        context.subscriptions.push(factory);
    }

    // TODO:
    // override VS Code's default implementation of the debug hover
    // here we match only Mock "variables", that are words starting with an '$'
    // context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('markdown', {
    //     provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {

    //         const VARIABLE_REGEXP = /\$[a-z][a-z0-9]*/ig;
    //         const line = document.lineAt(position.line).text;

    //         let m: RegExpExecArray | null;
    //         while (m = VARIABLE_REGEXP.exec(line)) {
    //             const varRange = new vscode.Range(position.line, m.index, position.line, m.index + m[0].length);

    //             if (varRange.contains(position)) {
    //                 return new vscode.EvaluatableExpression(varRange);
    //             }
    //         }
    //         return undefined;
    //     }
    // }));

    // TODO:
    // override VS Code's default implementation of the "inline values" feature"
    // context.subscriptions.push(vscode.languages.registerInlineValuesProvider('markdown', {

    //     provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext): vscode.ProviderResult<vscode.InlineValue[]> {

    //         const allValues: vscode.InlineValue[] = [];

    //         for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
    //             const line = document.lineAt(l);
    //             var regExp = /\$([a-z][a-z0-9]*)/ig;	// variables are words starting with '$'
    //             do {
    //                 var m = regExp.exec(line.text);
    //                 if (m) {
    //                     const varName = m[1];
    //                     const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);

    //                     // some literal text
    //                     //allValues.push(new vscode.InlineValueText(varRange, `${varName}: ${viewport.start.line}`));

    //                     // value found via variable lookup
    //                     allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));

    //                     // value determined via expression evaluation
    //                     //allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
    //                 }
    //             } while (m);
    //         }

    //         return allValues;
    //     }
    // }));
}

class WorkspaceFileAccessor implements FileAccessor {
    constructor(private context: vscode.ExtensionContext) {}

    async readFile(path: string): Promise<Uint8Array> {
        let uri: vscode.Uri;
        try {
            uri = pathToUri(path);
        } catch (e) {
            return new TextEncoder().encode(`cannot read '${path}'`);
        }

        return await vscode.workspace.fs.readFile(uri);
    }

    async writeFile(path: string, contents: Uint8Array) {
        await vscode.workspace.fs.writeFile(pathToUri(path), contents);
    }

    extensionPath(path: string): string {
        return this.context.asAbsolutePath(path);
    }
}

function pathToUri(path: string) {
    try {
        return vscode.Uri.file(path);
    } catch (e) {
        return vscode.Uri.parse(path);
    }
}

function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.backseat-debug.runEditorContents', (resource: vscode.Uri) => {
            let targetResource = resource;
            if (!targetResource && vscode.window.activeTextEditor) {
                targetResource = vscode.window.activeTextEditor.document.uri;
            }
            if (targetResource) {
                vscode.debug.startDebugging(
                    undefined,
                    {
                        type: 'bssembler',
                        name: 'Run File',
                        request: 'launch',
                        program: targetResource.fsPath
                    },
                    { noDebug: true }
                );
            }
        }),
        vscode.commands.registerCommand('extension.backseat-debug.debugEditorContents', (resource: vscode.Uri) => {
            let targetResource = resource;
            if (!targetResource && vscode.window.activeTextEditor) {
                targetResource = vscode.window.activeTextEditor.document.uri;
            }
            if (targetResource) {
                vscode.debug.startDebugging(
                    undefined,
                    {
                        type: 'bssembler',
                        name: 'Debug File',
                        request: 'launch',
                        program: targetResource.fsPath,
                        stopOnEntry: true
                    }
                );
            }
        })
    );
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    constructor(private context: vscode.ExtensionContext) {}

    createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new BssemblerDebugSession(new WorkspaceFileAccessor(this.context)));
    }
}
