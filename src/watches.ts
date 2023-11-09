'use strict';

import { DebugProtocol } from '@vscode/debugprotocol';

import { DebuggerWatch, VScriptVersion, WatchStatus } from "./customInterfaces";
import { arrayMapToArray } from "./utilities";
import { VScriptDebugSession } from "./vscriptDebug";

export function evaluateWatchRequest(debugSession: VScriptDebugSession, args: DebugProtocol.EvaluateArguments, response: DebugProtocol.EvaluateResponse)
{
	if(debugSession.startingFrameID === -1 && args.frameId !== undefined)
	{
		debugSession.startingFrameID = args.frameId;
	}
	let watch = addWatch(debugSession, debugSession.watchID, args.expression, "", 0, args.frameId);
	debugSession.watchesThisStep.push(watch.id);

	if(watch)
	{
		let variableKind = "data";
		let childElements = debugSession.watches.filter(element => (element.variableReference === watch.variableReference));
		let indexedVariables = 0;
		let namedVariables = 0;
		switch(watch.type)
		{
			case 'r':
			case 't':
				variableKind = "data";
				namedVariables = childElements.length;
				break;
			case 'a':
				variableKind = "data";
				indexedVariables = childElements.length;
				break;
			case 'native function':
			case 'fn':
				variableKind = "method";
				break;
			case 'y':
				variableKind = "class";
				break;
		}

		const frameID = args.frameId!;
		let watchStatus = watch.status[frameID];
		let watchResult = watch.values[frameID];
		let type = watch.type;

		let requiresUpdate = false;
		if(watchResult === undefined)
		{
			requiresUpdate = true;
			watchResult = debugSession.scriptVersion === VScriptVersion.squirrel2 ? "(step required to fetch)" : "(gathering data...)";
			type = "error";
		}
		else if(watchStatus === WatchStatus.error)
		{
			watchResult = "error";
			type = "error";
		}

		let presentationHint: DebugProtocol.VariablePresentationHint = {
			kind: variableKind
		};

		response.body = {
			result: watchResult.toString(),
			type: type,
			variablesReference: watch.variableReference,
			presentationHint: presentationHint,
			indexedVariables: indexedVariables,
			namedVariables: namedVariables
		};
		// the client can fire several request at once, the update packet can be big, we should only send it when all watches have been evaluated
		// timer will be reset every new request.
		if(debugSession.scriptVersion === VScriptVersion.squirrel3 && requiresUpdate) // only squirrel3 plus support update request
		{
			// if(VScriptDebugSession.config.get('displayRootTable')) // re-add the root table watch to not lose it later on.
			// {
			// 	addWatch(debugSession, 0, "clone ::getroottable()", "getroottable()", 0, 0, false);
			// }
			debugSession.sendUpdateRequest();
		}
		return response;
	}
}

export function watchExists(debugSession: VScriptDebugSession, id: number, expression: string): boolean
{
	if(!(id & 0x100000)) // regular watches
	{
		if(debugSession.watches.find(e => e.expression === expression))
		{
			return true;
		}
		else
		{
			return false;
		}
	}
	else // entity data reserverd.
	{
		let array = arrayMapToArray(debugSession.entityDataWatches);
		if(array.find(e => e.expression === expression))
		{
			return true;
		}
		else
		{
			return false;
		}
	}
}

export function addWatch(debugSession: VScriptDebugSession, id: number, expression: string, displayName: string = "", variableReference: number = 0, frameID: number = 0, affectTables: boolean = true): DebuggerWatch
{
	let watch = new DebuggerWatch(id, expression);
	if(!affectTables)
	{
		debugSession.socket?.write(`aw 0x${id.toString(16)}:${expression}\n`, "ascii");
		return watch;
	}
	// TODO make this section a little prettier??
	if(!(id & 0x100000)) // watches with this bitflag are reserved for gathering entity data
	{
		let existingWatch = debugSession.watches.find(e => e.expression === expression);
		if(!existingWatch)
		{
			debugSession.socket?.write(`aw 0x${id.toString(16)}:${expression}\n`, "ascii");
			debugSession.watches.push(watch);
		}
		else
		{
			return existingWatch;
		}
	}
	else
	{
		debugSession.socket?.write(`aw 0x${id.toString(16)}:${expression}\n`, "ascii");
		watch.displayName = displayName;
		let dataWatches = debugSession.entityDataWatches.get(variableReference);
		if(!dataWatches)
		{
			debugSession.entityDataWatches.set(variableReference, []);
			dataWatches = debugSession.entityDataWatches.get(variableReference);
		}
		dataWatches!.push(watch);
	}
	debugSession.watchID++;
	return watch;
}
export function removeWatch(debugSession: VScriptDebugSession, id: number, affectTables: boolean = false): void
{
	if(!affectTables)
	{
		debugSession.socket?.write(`rw 0x${id.toString(16)}`, "ascii");
		return;
	}

	if(!(id & 0x100000))
	{
		let watch = debugSession.watches.find(e => e.id === id);
		if(watch)
		{
			let idIndex = debugSession.watches.indexOf(watch);
			debugSession.watches.splice(idIndex, 1);
			debugSession.socket?.write(`rw 0x${id.toString(16)}`, "ascii");
		}
	}
	else
	{
		for (let [key, value] of debugSession.entityDataWatches) {
			if(!value) {continue;}

			// values are arrays
			let watch = value.find(e => e.id === id);
			if (!watch) {continue;}

			//console.log("removing watch: "+watch?.expression);
			let watchArray = debugSession.entityDataWatches.get(key);
			if(watchArray)
			{
				let idIndex = watchArray.indexOf(watch);
				watchArray.splice(idIndex, 1); // remove the element.
			}
			debugSession.socket?.write(`rw 0x${id.toString(16)}`, "ascii");
			break;
		}
	}
}