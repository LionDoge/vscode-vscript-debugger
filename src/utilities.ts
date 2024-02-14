'use strict';

import * as vscode from 'vscode';
import path = require('path');
import { DebuggerVariable } from './customInterfaces';
import { DebugProtocol } from '@vscode/debugprotocol';

// utility functions for conversions, independent of anything else.

/**
 * Pushes elements to a specific kind of map where values are arrays.
 * @param map The map object with values as arrays
 * @param key The key for the specific array of the map
 * @param items Items to push to the array
 * @returns the newly added items
 */
export function pushToMapArray<K, T>(map: Map<K, Array<T>>, key: K, ...items: Array<T>): Array<T>
{
	let array = map.get(key);
	if(!array)
	{
		map.set(key, Array<T>());
		array = map.get(key);
	}
	array?.push(...items);
	return items;
}

/**
 * Converts a specific map consisting of arrays as values, to a single array.
 * @param map The map object with values as arrays
 * @returns combined array of all arrays of the map
 */
export function arrayMapToArray<K, T>(map: Map<K,Array<T>>): Array<T>
{
	let mergedArray: Array<T> = [];
	for(const [_,array] of map.entries())
	{
		mergedArray = mergedArray.concat(array);
	}
	return mergedArray;
}

/**
 * Converts a specified file path to a Uniform Resource Identifier (URI)
 * @param path path to a file
 * @returns the path as URI
 */
export function pathToUri(path: string)
{
	try {
		return vscode.Uri.file(path);
	} catch (e) {
		return vscode.Uri.parse(path);
	}
}

/**
 * Return an array of strings containing paths to all workspace root folders
 * @returns The main path which VScripts reside in
 */
export function getScriptRootDirectories(): Array<string>
{
	let workspacePaths: Array<string> = [];
	if(!vscode.workspace.workspaceFolders)
	{
		if(vscode.window.activeTextEditor)
		{
			workspacePaths.push(path.dirname(vscode.window.activeTextEditor.document.fileName));
		}
		else
		{
			return [];
		}
	}
	else
	{
		workspacePaths = vscode.workspace.workspaceFolders.map((folder) => folder.uri.fsPath);
	}
	return workspacePaths;
}

/**
 * Turns an absolute path to a script to one that is relative to the main script folder.
 *
 * WARNING: This won't check if the script is actually here in case it has been found by 'additionalScriptDirectories' launch argument.
 * @param srcpath Absolute path to the script
 * @returns Relative path to the script
 */
export function getRelativeScriptPath(srcpath: string)
{
	let currentpath = srcpath;
	while(path.basename(currentpath) !== "vscripts")
	{
		if(currentpath === path.dirname(currentpath))
		{
			return srcpath;
		}
		currentpath = path.dirname(currentpath);
	}
	return path.relative(currentpath, srcpath);
}

/**
 * Converts an internal debugger variable type to one compliant with DAP
 * @param v The variable
 * @returns The variable type matching the Debug Adapter Protocol
 */
export function convertVariableToDAP(v: DebuggerVariable): DebugProtocol.Variable
{
	let variableKind = "data";
	//let childElements = this.localVariables.filter(element => v.variableReference);
	//let indexedVariables = 0;
	//let namedVariables = 0;
	switch(v.type)
	{
		case 'r':
		case 't':
			variableKind = "data";
			//namedVariables = childElements.length;
			break;
		case 'a':
			variableKind = "data";
			//indexedVariables = childElements.length;
			break;
		case 'native function':
		case 'fn':
			variableKind = "method";
			break;
		case 'y':
			variableKind = "class";
			break;
	}

	let presentationHint: DebugProtocol.VariablePresentationHint;
	if(v.presentationHint) { presentationHint = v.presentationHint;} // override with variable's presentation hint if it's present
	else
	{
		presentationHint = {
			kind: variableKind
		};
	}

	let dapVariable: DebugProtocol.Variable = {
		name: v.name,
		value: v.value.toString(),
		type: typeStringFromChar(v.type),
		variablesReference: v.variableReference,
		evaluateName: '$' + v.name,
		presentationHint: presentationHint
		//namedVariables: namedVariables,
		//indexedVariables: indexedVariables
	};

	return dapVariable;
}

/**
 * Converts a shortened type character from the debug server to a readable one
 * @param char type character
 * @returns full readable type, in case no matches are found the original character is returned.
 */
export function typeStringFromChar(char: string): string
{
	switch(char)
	{
		case 'i': return "integer";
		case 'f': return "float";
		case 'b': return "boolean";
		case 's': return "string";
		case 't': return "table";
		case 'a': return "array";
		case 'x': return "object";
		case 'y': return "class";
		case 'fn': return "function";
		case 'n': return "null";
		case 'g': return "function generator";
		case 'h': return "thread";
		case 'u': return "userdata";
		default:
			return char;
	}
}