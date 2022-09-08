'use strict';

import * as vscode from 'vscode';
import { activateDebug } from './activateDebug';

export function activate(context: vscode.ExtensionContext) {
    activateDebug(context);
}

export function deactivate() {
    // nothing to do
}
