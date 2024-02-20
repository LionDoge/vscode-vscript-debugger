'use strict';

import * as vscode from 'vscode';
import {window} from 'vscode';
import { getScriptRootDirectories, pathToUri } from "./utilities";
import { VScriptDebugSession } from './vscriptDebug';
import path = require('path');

// contains functions for resolving file references, and prompting the user in case of issues with them.
export async function resolveFileReference(debugSession: VScriptDebugSession, filename: string, errorOnMissing=true, askUser=false): Promise<string | string[] | void>
{
	// L4D2 gives full path, we don't need all of this for this case:
	let fileNames: string[] = [];
	let filesArraysArray: Array<Array<string>> = []; // mainly used for distinguising and displaying in quickpick.

	// L4D2 case:
	let l4d2_notFound = false;

	const pathPrefix = "scripts/vscripts";
	if(filename.startsWith(pathPrefix))
	{
		const scriptDirectories: Array<string> = getScriptRootDirectories().concat(debugSession.additionalScriptDirectories);
		let fileThenables: Thenable<number>[] = [];
		let fileIdx = 0;
		for(let scriptPath of scriptDirectories)
		{
			let fileString = path.join(scriptPath, filename.slice(pathPrefix.length + 1));
			let fileUri = vscode.Uri.file(fileString);

			fileNames.push(fileString); // fs.stat doesn't give us back the filename, we need to remember it.
			fileThenables.push(
				vscode.workspace.fs.stat(fileUri).then((value: vscode.FileStat) => {
					return fileIdx;
				})
			);
			fileIdx++;
		}
		// we do not look at the case where there are multiple files found (in L4D2) as that would mean that the game loads one of it
		// and we don't really know which one, so this is "undefined behavior" for us. (whicever file is found first)
		
		let completedPromise = Promise.any(fileThenables);
		await completedPromise.then((validFileIndex: number) => {
			fileIdx = validFileIndex;
		}).catch(() => l4d2_notFound = true);

		if(!l4d2_notFound)
		{
			// we just use an array with one element to be compatible with rest of the code, and without having to do additional checks etc.
			fileNames = [fileNames[fileIdx]]; // we care about one file only...
		}
	}
	else // other games don't support full paths.
	{
		let filesPromises: Promise<string[]>[] = [];
		const scriptDirectories: Array<string> = getScriptRootDirectories().concat(debugSession.additionalScriptDirectories);
		for(let directory of scriptDirectories)
		{
			// TODO: get current workspace directory from VScriptConfigurationProvider to resolve relative paths.
			// this is for directories that are not absolute, we need to make them absolute.
			/*
			if(!path.isAbsolute(directory))
			{
				directory = path.join(debugSession.currentWorkPath, directory);
			}*/
			filesPromises.push(findFileRecusive(directory, filename));
		}
		await Promise.allSettled(filesPromises).then((promiseResults: PromiseSettledResult<string[]>[]) => {
			let fileDirs: Array<string> = [];
			for(let promise of promiseResults)
			{
				if(promise.status === "fulfilled")
				{
					fileDirs = fileDirs.concat(promise.value);
					filesArraysArray.push(promise.value);
				}
			}

			for(let filedir of fileDirs)
			{
				// a way to avoid dupes, quite a bit slower than just concact, but realistically we won't have much directories in here anyways.
				filedir = filedir.replace(/\\/g, "/");
				if(!fileNames.includes(filedir))
				{
					fileNames.push(filedir);
				}
			}
		});
	}

	// other games only return the filename, no path given, we don't know what file it is exactly...

	if (fileNames.length > 1) // if we have more than one then we have to let the user know and notify them.
	{
		if(askUser)
		{
			return presentFileQuickPick(debugSession, filesArraysArray);
		}
		else // if we don't prompt the user, but want info about all the files we return an array.
		{
			return new Promise<void | string | string[]>((resolve, reject) => {
				resolve(fileNames);
			});
		}
	}
	else if (fileNames.length <= 0 || l4d2_notFound) {

		if(errorOnMissing)
		{
			return presentFileMissingMessage(debugSession, filename);
		}
		else // no file found, but we don't show errors, let's return just the file name itself, so at least it could be displayed in the call stack view
		{
			return filename;
		}
	}
	else // we found just one file, we can just return it!
	{
		return fileNames[0];
	}
}


/**
 * Shows a VS Code error message for a file that was not found
 * @param debugSession VScriptDebugSession
 * @param filename the name for the file which was not found
 */
function presentFileMissingMessage(debugSession: VScriptDebugSession, filename: string)
{
	return new Promise<string>((resolve, reject) => {
		const RESUME_TEXT = "Resume";
		const STEPOUT_TEXT = "Step Out";

		window.showErrorMessage("File: "+filename+" not found in the current workspace. Add paths in 'additionalScriptDirectories' to launch.json to search in more specified locations.",
		 { title: RESUME_TEXT }, { title: STEPOUT_TEXT}, {title: "Ignore"}).then((choice) => {
			if(choice)
			{
				if(choice.title === RESUME_TEXT)
				{
					debugSession.resumeExecution();
				}
				else if(choice.title === STEPOUT_TEXT)
				{
					debugSession.stepOut();
				}
			}
			resolve(filename); // resolve the filename anyways so it is registered and so we don't try to find it again.
		});
	});
}

/**
 * Displays information about the file being internal and not displayable.
 * @param debugSession VScriptDebugSession
 */
export function presentFileNotRealMessage()
{
	window.showInformationMessage("For your information the entry at the top of call stack is not an actual file but an internal one which can not be displayed in the editor, thus you will not be able to see its contents.", {title: "Ok"});
}

/**
 * Presents the user with an option to pick from multiple files as a VS Code QuickPick, or an option such as 'resume' or 'step out'
 * @param debugSession VScriptDebugSession
 * @param filesArraysArray Array of Arrays of files, The index of the outer array is a script directory reference
 * @returns promise that resolves to a file path (or void if the chosen option was not a file)
 */
function presentFileQuickPick(debugSession: VScriptDebugSession, filesArraysArray: Array<Array<string>>): Promise<void | string>
{
	return new Promise<void | string>((resolve, reject) => {

	let fileNames: Array<string> = [];
	for(let filedirs of filesArraysArray)
	{
		fileNames = fileNames.concat(filedirs);
	}

	let quickPickItemList = new Array<vscode.QuickPickItem>;
	let directories: Array<string> = getScriptRootDirectories().concat(debugSession.additionalScriptDirectories);

	for(let [idx, scriptDirectory] of directories.entries())
	{
		let detail = scriptDirectory;
		let filesArray = filesArraysArray[idx];
		if(!filesArray) {filesArray = [];}
		quickPickItemList = quickPickItemList.concat(filesArray.map((element: string, index: number) => {
			return <vscode.QuickPickItem>{
				alwaysShow: true,
				label: "$(file-code) "+path.relative(scriptDirectory, element),
				detail: detail
			};
		}));

	}
	let fileItemsAmount = quickPickItemList.length;
	// separator
	quickPickItemList.push(<vscode.QuickPickItem>{alwaysShow: true, kind: vscode.QuickPickItemKind.Separator});
	// control buttons
	quickPickItemList.push(<vscode.QuickPickItem>{alwaysShow: true, label: "$(debug-step-out) Ignore and step out"});
	quickPickItemList.push(<vscode.QuickPickItem>{alwaysShow: true, label: "$(debug-start) Ignore and resume execution"});
	quickPickItemList.push(<vscode.QuickPickItem>{alwaysShow: true, label: "Ignore"});

	// Finally show the quick pick
	window.showQuickPick(quickPickItemList, <vscode.QuickPickOptions>{
		title: "Ambigous file reference, pick which is the one that should be displayed during debugging",
		canPickMany: false,
		ignoreFocusOut: true,
	}).then((choice) => {
		if(!choice)
		{
			resolve();
			return;
		}

		let itemIndex = quickPickItemList.findIndex((element) => element === choice);
		//console.log("file item index: "+itemIndex+ " file: "+fileNames[itemIndex]);

		if(itemIndex < fileItemsAmount) // it's an actual file item
		{
			resolve(fileNames[itemIndex]);
		}
		else // it's one of custom options
		{
			switch(choice)
			{
				case quickPickItemList[fileItemsAmount+1]: // step out
					debugSession.stepOut();
					break;
				case quickPickItemList[fileItemsAmount+2]: // resume
					debugSession.resumeExecution();
					break;
				case quickPickItemList[fileItemsAmount+3]: // ignore
				default:
					break;
			}
			resolve();
		}
	});

	});
}

/**
 * Finds all files matching a filename in all children directories to the specified one inclusive
 * @param directory The directory to which begin the search from
 * @param filename The name to find
 * @returns Promise of array of file paths.
 */
export async function findFileRecusive(directory: string, filename: string): Promise<Array<string>>
{
	let filesArray: Array<string> = [];
	let uri = pathToUri(directory);
	let files = vscode.workspace.fs.readDirectory(uri);
	//TODO: Make it not await, this just slows down the search!
	await files.then(async (tupleArray) => {
		for(let fileTuple of tupleArray)
		{
			const name = fileTuple[0];
			const type = fileTuple[1];
			if(type === vscode.FileType.Directory)
			{
				filesArray = filesArray.concat(await findFileRecusive(path.join(directory, name), filename));
			}
			else if(type === vscode.FileType.File || type === vscode.FileType.SymbolicLink)
			{
				if(name === filename && !filesArray.includes(path.join(directory, name)))
				{
					filesArray.push(path.join(directory, name));
				}
			}
		}
	});
	return new Promise<Array<string>>((resolve,reject) => {resolve(filesArray);});
}