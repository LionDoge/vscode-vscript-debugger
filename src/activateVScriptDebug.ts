// Code based on mock debug extension repository by Microsoft
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

// these keywords differ between v2 and v3. I'll be targeting v3 for now only.

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { VScriptDebugSession } from './vscriptDebug';
import { FileAccessor } from './customInterfaces';
import { registerEvaluateFunctions } from './hover';
import { squirrelReservedKeywords } from './customInterfaces';

export function activateVScriptDebug(context: vscode.ExtensionContext, factory?: vscode.DebugAdapterDescriptorFactory) {

	// register a command that sets up a basic launch.json config for attaching.
	context.subscriptions.push(
		vscode.commands.registerCommand('extension.vscript-debug.attachDebugger', () => {
			vscode.debug.startDebugging(undefined, {
				type: 'vscript',
				name: 'VScript',
				request: 'attach',
				engineVersion: 'Squirrel2'
			});
		})
	);
	// register a configuration provider
	const provider = new VScriptConfigurationProvider();
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vscript', provider));

	//register a dynamic configuration provider
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('vscript', {
		provideDebugConfigurations(folder: WorkspaceFolder | undefined): ProviderResult<DebugConfiguration[]> {
			return [
				{
					name: "VScript Squirrel2",
					request: "attach",
					type: "vscript",
					engineVersion: "Squirrel2"
					// ip is defaulted to localhost in the configuration.
				},
				{
					name: "VScript Squirrel3",
					request: "attach",
					type: "vscript",
					engineVersion: "Squirrel3"
				}
			];
		}
	}, vscode.DebugConfigurationProviderTriggerKind.Dynamic));

	if (!factory) {
		factory = new InlineDebugAdapterFactory();
	}
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('vscript', factory));
	// if ('dispose' in factory) {
	// 	context.subscriptions.push(factory);
	// }

	// override VS Code's default implementation of the debug hover
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('squirrel', {
		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {

			const VARIABLE_REGEXP = /(\w+)\s*=|(\w+)\s*<-\s*/ig; // match assignments and table entries.
			const line = document.lineAt(position.line).text;

			let m: RegExpExecArray | null;
			while (m = VARIABLE_REGEXP.exec(line)) {
				if(m[1] in squirrelReservedKeywords) {continue;} // if the variable names is just a keyword
				const varRange = new vscode.Range(position.line, m.index, position.line, m.index + m[1].length);

				if (varRange.contains(position)) {
					return new vscode.EvaluatableExpression(varRange);
				}
			}
			return undefined;
		}
	}));

	// override VS Code's default implementation of the "inline values" feature"
	context.subscriptions.push(vscode.languages.registerInlineValuesProvider('squirrel', {

		provideInlineValues(document: vscode.TextDocument, viewport: vscode.Range, context: vscode.InlineValueContext) : vscode.ProviderResult<vscode.InlineValue[]> {

			const allValues: vscode.InlineValue[] = [];

			for (let l = viewport.start.line; l <= context.stoppedLocation.end.line; l++) {
				const line = document.lineAt(l);
				var regExp = /(\w+)\s*=|(\w+)\s*<-\s*/ig;
				do {
					var m = regExp.exec(line.text);
					if (m) {
						const varName = m[2];
						if(varName in squirrelReservedKeywords) {continue;}

						const varRange = new vscode.Range(l, m.index, l, m.index + varName.length);

						// some literal text
						//allValues.push(new vscode.InlineValueText(varRange, `${varName}: ${viewport.start.line}`));

						// value found via variable lookup
						allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));

						// value determined via expression evaluation
						//allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
					}
				} while (m);
			}

			return allValues;
		}
	}));

	// override VS Code's default implementation of the debug hover
	// override VS Code's default implementation of the "inline values" feature"
	registerEvaluateFunctions(context);
}

class VScriptConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		// if launch.json is missing or empty
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'squirrel') {
				config.type = 'vscript';
				config.name = 'Attach';
				config.request = 'attach';
				config.stopOnEntry = true;
				config.engineVersion = "Squirrel2";

				const titleSq2 = "Squirrel 2.x";
				const titleSq3 = "Squirrel 3.x";
				const quickPickOptions: Array<vscode.QuickPickItem> = [
					{label: titleSq2, description: "For CS:GO, Portal 2 and other games that use Squirrel version 2.x for VScripts.", detail: "Choose this option if in doubt"},
					{label: titleSq3, description: "For L4D2, TF2 and other games that use Squirrel version 3.x for VScripts."}
				];
				return vscode.window.showQuickPick(quickPickOptions, <vscode.QuickPickOptions>{
					title: "Pick the VScript Squirrel version you want to debug.",
					canPickMany: false
				}).then( (pickedItem) => {
					if(!pickedItem) {return undefined;}

					switch(pickedItem.label)
					{
						case titleSq2:
							config.engineVersion = "Squirrel2";
							break;
						case titleSq3:
							config.engineVersion = "Squirrel3";
							break;
					}
					return config;
				});

			}
		}

		return config;
	}
}

export const workspaceFileAccessor: FileAccessor = {
	isWindows: false,
	async readFile(path: string): Promise<Uint8Array> {
		let uri: vscode.Uri;
		try {
			uri = pathToUri(path);
		} catch (e) {
			return new TextEncoder().encode(`cannot read '${path}'`);
		}

		return await vscode.workspace.fs.readFile(uri);
	},
	async writeFile(path: string, contents: Uint8Array) {
		await vscode.workspace.fs.writeFile(pathToUri(path), contents);
	}
};

function pathToUri(path: string) {
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
		return new vscode.DebugAdapterInlineImplementation(new VScriptDebugSession(workspaceFileAccessor));
	}
}
