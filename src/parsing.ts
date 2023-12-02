'use strict';

import { VScriptDebugSession } from "./vscriptDebug";
import { parseString } from 'xml2js';
import { DebuggerState, DebuggerVariable, DebuggerWatch, IBasicType, WatchStatus, TreeNode, ReferenceVariable, Queue, VScriptVersion } from "./customInterfaces";
import { StoppedEvent,  OutputEvent, InvalidatedEvent, StackFrame,  ContinuedEvent, BreakpointEvent } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { resolveFileReference, presentFileNotRealMessage } from "./fileReferences";
import { arrayMapToArray, getRelativeScriptPath, pushToMapArray, typeStringFromChar } from "./utilities";
import { decode } from 'html-entities';
import * as path from "path";

/**
 * Check if a variable is an entity handle based on its functions
 * @param referenceList The parsed XML data of the Object reference section
 * @param reference The variable reference number (server side)
 * @returns true if variable is an Entity Handle
 */
export function isVariableEHandle(referenceList, reference: number): boolean
{
	for(let obj of referenceList)
	{
		if(obj['$']['ref'] !== String(reference)) {continue;}
		if(!obj['e']) {return false;} // no elements, no possibility of being an entity.

		for(let element of obj['e'])
		{
			if(element['$']['vt'] === "native function" && element['$']['kv'] === "entindex")
			{
				return true;
			}
		}
		return false; // indeed we want to stop here.
	}
	return false;
	//return !!this.localVariables.get(reference)!.find( element => ( element.type === "native function" && element.name === "entindex" ) );
}

function resetRootReferenceTree(tree: TreeNode<ReferenceVariable>)
{
	tree.element.firstName = "@root@";
	tree.element.reference = 0;
	tree.element.variableType = "r";
	tree.children = [];
}

export function referenceTreeBFS(tree: TreeNode<ReferenceVariable>, callback: ((node: TreeNode<ReferenceVariable>) => boolean)): TreeNode<ReferenceVariable> | undefined
{
	let queue = new Queue<TreeNode<ReferenceVariable>>();
	let visited = Array<number>();

	visited.push(tree.element.reference);
	queue.enqueue(tree);

	while(queue.length() > 0)
	{
		let node = queue.dequeue();
		if(node)
		{
			visited.push(node.element.reference);
			if(callback!== undefined)
			{
				if(callback(node))
				{
					return node;
				}
			}

			for(let childNode of node.children)
			{
				if(!visited.includes(childNode.element.reference))
				{
					visited.push(childNode.element.reference);
					queue.enqueue(childNode);
				}
			}
		}
	}
}

// recursively find children references and build a tree.
function buildReferenceTree(referenceList, serverReference: number, name: string, type: string, parentNode: TreeNode<ReferenceVariable>, depth=0, searchedElementsList: Array<number>): TreeNode<ReferenceVariable> | undefined
{
	let tree: TreeNode<ReferenceVariable> = {} as TreeNode<ReferenceVariable>;
	let treeElement: ReferenceVariable;

	let obj = referenceList.find(e => e['$']['ref'] === String(serverReference));
	if(!obj['e']) {return undefined;}
	if (searchedElementsList.includes(serverReference)) {return undefined;}
	searchedElementsList.push(serverReference);
	treeElement = {reference: serverReference, firstName: name, variableType: type};
	tree = {
		element: treeElement,
		children: [],
		parent: parentNode,
		depth: depth
	};

	for(let element of obj['e'])
	{
		if(isComplexDataType(element['$']['vt']))
		{
			// value will be a reference number
			// in the call the element parameter of the tree node will be assigned to the passed values
			let newNode = buildReferenceTree(referenceList, Number(element['$']['v']), element['$']['kv'], element['$']['vt'], tree, depth++, searchedElementsList);
			if(newNode)
			{
				tree.children.push(newNode);
			}
		}
	}

	return tree;
}

function isComplexDataType(shorttype: string)
{
	switch(shorttype)
	{
		case "t": // table
		case "r": // reference, most likely complex type (basic types aren't references)
		case "a": // array
		case "x": // object
		case "y": // class definition
			return true;
		default:
			return false;
	}
}

function parseBreakpoint(debugSession: VScriptDebugSession, bpLine: number, bpFile: string)
{
	const relativeScriptPath = getRelativeScriptPath(bpFile);
	let breakPointList = debugSession._breakpoints.get(relativeScriptPath);
	// This is not really perfect as it will verify every file of just that filename even if the breakpoint has not really been verified before.
	// However it is quite hard to make it work 100% correctly, and I haven't found any case where the game wouldn't verify a breakpoint instantly anyways, it's more of a semantic check I'd say.

	if(breakPointList) // this is just a case for l4d2, since here relative script path will always match the name received from game.
	{
		let bp = breakPointList!.find(breakpoint => breakpoint.line === bpLine);
		if(bp)
		{
			bp.verified = true;
			debugSession.sendEvent(new BreakpointEvent("changed", bp));
		}
	}
	// in other case we have to do search just by the basename, here we just assume every file of the same name to be verified, provided that the exact breakpoint line number exists.
	else
	{
		for (const key of debugSession._breakpoints.keys())
		{
			// mostly for the case of squirrel 2
			if(path.basename(key) === relativeScriptPath)
			{
				breakPointList = debugSession._breakpoints.get(key);
				let bp = breakPointList!.find(breakpoint => breakpoint.line === bpLine);
				if(bp)
				{
					bp.verified = true;
					debugSession.sendEvent(new BreakpointEvent("changed", bp));
				}
			}
		}
	}
}

async function parseCall(debugSession: VScriptDebugSession, call, forceLineNumber: number | undefined = undefined, correctedSource: string | undefined = undefined)
{
	let stackFramePresentationHint: "normal" | "label" | undefined = "normal";
	let src: DebugProtocol.Source;

	let filePathPromise;
	let filePath: string | string[] | undefined;
	let firstCall: boolean = debugSession.stackFrameID === 0;
	let source: string;
	if(correctedSource)
	{
		source = correctedSource;
	}
	else
	{
		source = call['$']['src'];
	}

	if(source.endsWith(".nut"))
	{
		if(firstCall)
		{
			const fileRefData = debugSession.resolvedFileReferences.get(source);
			const fullPath: string | undefined = debugSession.resolvedFileReferences.get(source)?.fullpath;
			if(!fileRefData || fileRefData.count > 1)  // we got more than one of the same name, and one of these is at the top.
			{
				filePathPromise = resolveFileReference(debugSession, source, true, true);
				await filePathPromise.then((file: string | string[] | undefined) => {
					filePath = file;
					if(typeof filePath === 'string') // just one file.. In this case this check is redundant, it's just to make TS happy.
					{
						debugSession.resolvedFileReferences.set(source, {fullpath: filePath, count: 1});
					}
				});
			}
			else
			{
				filePath = fullPath;
			}
		}
		else
		{
			// Automatically resolve files lower on the stack, as asking for each could get annoying. The files will be resolved after clicking on them on the call
			filePathPromise = resolveFileReference(debugSession, source, false, false);
			await filePathPromise.then((file: string | string[] | void) => {
				if(Array.isArray(file)) // multiple files. We get an array so we know there's more than one and the reference is unconfirmed.
				{
					filePath = file[0];
				}
				else if(file !== undefined) // it's just one file we can set it as resolved reference
				{
					filePath = file;
					debugSession.resolvedFileReferences.set(source, {fullpath: filePath, count: 1});
				}
			});
		}

		if(typeof filePath === 'string')
		{
			src = debugSession.createSource(filePath);
			stackFramePresentationHint = "normal";
		}
		else // no file path, we can't do anything... Resuming is handled by resolveFileReference method.
		{
			return;
		}
	}
	else { // Not a real file, probably internal game function. (includes .nuc files, which we don't support)
		src = debugSession.createSource(source);
		src.presentationHint = "deemphasize";
		// if it's first call it would be a good idea to notifty what's going on
		if(firstCall)
		{
			presentFileNotRealMessage();
		}
	}
	let line = Number(call['$']['line']);

	if (forceLineNumber !== undefined)
	{
		line = Number(forceLineNumber);
	}

	let newFrame = new StackFrame(debugSession.stackFrameID++, call['$']['fnc'], undefined, line);
	newFrame.source = src;
	newFrame.presentationHint = stackFramePresentationHint;
	return newFrame;
}

function parseWatch(debugSession: VScriptDebugSession, watch, currentFrame: number): number[] | undefined
{
	let watchId = Number(watch['$']['id']);
	//let expression = watch['$']['exp'];
	let status = watch['$']['status'];

	let debuggerWatch: DebuggerWatch | undefined;
	if (!(watchId & 0x100000)) {
		debuggerWatch = debugSession.watches.find(element => element.id === watchId);
	}
	else {
		debuggerWatch = arrayMapToArray<number, DebuggerWatch>(debugSession.entityDataWatches).find(element => element.id === watchId);
	}

	if (debuggerWatch) {
		debuggerWatch.frameId = currentFrame;
		let watchValidationPair = [watchId, currentFrame];
		if (status === "ok") {
			let value = watch['$']['val'];
			let shorttype = watch['$']['type'];
			debuggerWatch.status[currentFrame] = WatchStatus.ok;
			debuggerWatch.values[currentFrame] = variableToValue(debugSession, value, shorttype);
			debuggerWatch.type = typeStringFromChar(shorttype);
			debuggerWatch.isValid = true;
			if (isComplexDataType(shorttype))
			{
				debuggerWatch.variableReference = Number(value) + 1;
				// SPECIAL CASE: watch of id 0 is the roottable. We display it in scopes view.
				if(watchId === 0)
				{
					// we need to save the reference of it to know how to display it when we get a request.
					debugSession.rootTableReference = Number(value);
				}
			}

			return watchValidationPair;
		}
		else if(status === "error") {
			debuggerWatch.values[currentFrame] = "error";
			debuggerWatch.status[currentFrame] = WatchStatus.error;
		}
	}
}

function parseLocalVariable(debugSession: VScriptDebugSession, local, currentFrame: number): DebuggerVariable
{
	let name = local['$']['name'];
	let shorttype = local['$']['type'];
	let originalvalue = local['$']['val'];

	let value = variableToValue(debugSession, originalvalue, shorttype); // convert to a shortened display value if needed.
	let variable = new DebuggerVariable(name, value, shorttype);
	variable.variablePath = name;

	// only variables at the top need a frameID, others could be shared with other frames.
	variable.frameId = currentFrame;

	// tables and references.
	if (isComplexDataType(shorttype)) // if it's any of this type we treat the value as variable reference.
	{
		if (shorttype === 'a')
		{
			variable.isIndexed = true;
		}
		if (name === "this")
		{
			variable.hidden = true;
		}

		if(shorttype === "native function" && debugSession.hideNativeFunctions)
		{
			variable.hidden = true;
		}
		else if(shorttype === "y" && debugSession.hideClasses)
		{
			variable.hidden = true;
		}

		variable.variableReference = Number(originalvalue) + 1; // we start from 0 meanwhile DAP requires that we start from 1 for expandable variables.
		let newNode = buildReferenceTree(debugSession.currentParsedReferences, Number(originalvalue), name, shorttype, debugSession.referenceTree, 0, debugSession.visitedTreeElements);
		if(newNode)
		{
			debugSession.referenceTree.children.push(newNode);
		}
		if(VScriptDebugSession.config.get('displayRootTable') && debugSession.rootTableReference >= 0)
		{
			let rootNode = buildReferenceTree(debugSession.currentParsedReferences, debugSession.rootTableReference, "@ROOTTABLE@", "t", debugSession.referenceTree, 0, debugSession.visitedTreeElements);
			if(rootNode)
			{
				debugSession.referenceTree.children.push(rootNode);
			}
		}
	}

	if (shorttype === 'x' && isVariableEHandle(debugSession.currentParsedReferences, Number(originalvalue))) {
		let dataWatches = debugSession.entityDataWatches.get(variable.variableReference);
		if (!dataWatches) {
			//this.setupEntityData(variable);
		}
		else {
			//if(this.localVariables.find(element => element.childReference === variable.variableReference && element.type === "native function" && element.name === "entindex"))
			//{
			//	variable.value = "Entity handle";
			//}
			//this.createVariablesFromWatches(dataWatches, variable, variablesAcquireDefer);
		}

	}
	return variable;
}

export function parseReceivedData(debugSession: VScriptDebugSession, receivedData)
{
	if(debugSession.resumeTimer)
	{
		clearTimeout(debugSession.resumeTimer);
	}
	if(receivedData === "<resumed/>\r\n")
	{
		debugSession.debuggerState = DebuggerState.runnning;
		debugSession.resetState();
		if(debugSession.scriptVersion === VScriptVersion.squirrel3)
		{
			// Squirrel 2 is bugged with removing watches at all. Let's not bother with that, it's not the end of the world. And watches dissapear upon disconnect anyways.
			// Observation: Sending 'go' request after removing a watch seems to make the game work again, however sometimes I noticed some other issues when doing that...
			debugSession.cleanupUnusedWatches();
		}
		debugSession.sendEvent(new ContinuedEvent(VScriptDebugSession.threadID));
		return;
	}
	debugSession.watchesThisStep = [];

	// auto resume on exceptions when exception breakpoint is unchecked, the debug server doesn't support disabling them so it's best we can do.
	if(debugSession.resumeOnExceptions && debugSession.debuggerState !== DebuggerState.stopped) // last condition is used to not skip exceptions that were hit with stepping.
	{
		// numbers here are choosen kind of arbitrarly, but are made sure to work in "basically every case" (pinky promise)
		let partialString = receivedData.slice(0, 120);
		if(partialString.includes("error=", 25)) // we'll check if the data sent is an exception without fully parsing the string to save time, as we will be resuming and ignoring anyways if that's the case.
		{
			debugSession.resumeExecution();
			debugSession.resetFileReferences();
			return;
		}
	}

	// if we don't do any stuff above, we now start parsing the entirety of the xml data.
	parseString(receivedData, {trim: true}, async (err,data) => {
		if(err)
		{
			debugSession.sendEvent(new OutputEvent("An error has occured while parsing data from the server: "+err.message, "stderr"));
			// we don't know what went wrong, really, it could be everything, in fact we could be not even connected to the game but something else.
			// resuming makes sure that the user is not stuck in a limbo state, the debugger will try to recover if it can.
			debugSession.resumeExecution();
			return;
		}

		if(data['addbreakpoint'] !== undefined)
		{
			parseBreakpoint(debugSession, Number(data['addbreakpoint']['$']['line']), data['addbreakpoint']['$']['src']);
			return;
		}

		// let's ignore break events with descriptions for now.
		if (!((data['break'] !== undefined && !data['break']['$']['desc']) || data['update'] !== undefined)) {return;}

		let reason: string = "";
		let currentLineBreak: Number = 1;

		let isUpdateData = false;

		if(data['update'] !== undefined)
		{
			isUpdateData = true;
		}
		else
		{
			currentLineBreak = Number(data['break']['$']['line']);
			reason = data['break']['$']['type'];
		}

		const dataRoot = isUpdateData ? data['update'] : data['break'];
		debugSession.currentParsedReferences = dataRoot['objs']['0']['o'];

		// reset all the variables and put new ones in
		debugSession.localVariables.clear();
		debugSession.localVariables.set(0, []);
		debugSession.rootVariables = [];
		resetRootReferenceTree(debugSession.referenceTree);

		let currentFrame = 0;
		let stackFrames: StackFrame[] = [];


		debugSession.startingFrameID = -1;
		debugSession.virtualReference = 10000;

		let validatedWatchesIDs: number[][] = [];
		debugSession.currentFrameID = 0;
		for (let call of dataRoot['calls']['0']['call']) {

			if(!isUpdateData) // don't touch the call stack if we're only recieving update data.
			{
				let correctedLineNumber: number | undefined;
				let correctedSource: string | undefined;
				// sometimes the topmost call line doesn't match with the one in the beginning of xml data?? I don't fully understand, let this serve as a workaround for now.
				if(debugSession.stackFrameID === 0)
				{
					// For unknown reasons sometimes the the 'break' arguments differ from the first call's arguments. From observation it looks like the ones in 'break' are usually the correct ones.
					correctedLineNumber = data['break']['$']['line'];
					correctedSource = data['break']['$']['src'];
				}
				await parseCall(debugSession, call, correctedLineNumber, correctedSource).then((value) => {
					if(value)
					{
						stackFrames.push(value);
					}
				});

				debugSession.stacktraces = stackFrames;
			}

			// iterate over all watch expressions and apply their values for use later.
			if (call['w']) {
				for (let watch of call['w'])
				{
					let watchValidationPair = parseWatch(debugSession, watch, currentFrame);
					if(watchValidationPair && !validatedWatchesIDs.includes(watchValidationPair))
					{
						validatedWatchesIDs.push(watchValidationPair);
					}
				}
			}

			if(call['l'])
			{
				let variables = debugSession.localVariables.get(0); // the 0 is the reference handle for top level local variables
				if(!variables)
				{
					debugSession.localVariables.set(0, []);
					variables = debugSession.localVariables.get(0);
				}
				for (let local of call['l']) {
					variables!.push(parseLocalVariable(debugSession, local, currentFrame));
				}
			}
			currentFrame++;
		}


		if(isUpdateData)
		{
			debugSession.sendEvent(new InvalidatedEvent(["variables"], VScriptDebugSession.threadID));
			return; // don't fire any stopped events
		}

		if (reason === 'breakpoint') {
			debugSession.sendEvent(new StoppedEvent(reason, VScriptDebugSession.threadID));
			debugSession.debuggerState = DebuggerState.stopped;
		}
		else if (reason === 'error') {
			let exception = decode(data['break']['$']['error']);
			debugSession.debuggerState = DebuggerState.errored;
			let description = "An error has occured in " + (debugSession.stacktraces[0].source?.path || "<unknown>") + " at line " + currentLineBreak + ": " + exception + "\n"; //+ " | " + getRandomWittyComment() + "\n";
			debugSession.sendEvent(new OutputEvent(description, 'stderr'));

			debugSession.exceptionInfo.description = exception;
			let stackTraces = debugSession.stacktraces;
			let traceString = "";
			if(stackTraces)
			{
				let isFristTrace = true;
				for(let trace of stackTraces)
				{
					traceString+=trace.name + "\t("+trace.source?.name+" @ line " +trace.line+")" + (isFristTrace ? " <- HERE":"")+"\n";
					isFristTrace = false;
				}
			}

			debugSession.exceptionInfo.details = {
				message: "STACK TRACE:",
				stackTrace: traceString
			};

			debugSession.sendEvent(new StoppedEvent('exception', VScriptDebugSession.threadID, exception));
		}
		else {
			debugSession.sendEvent(new StoppedEvent(reason, VScriptDebugSession.threadID));
			debugSession.debuggerState = DebuggerState.stopped;
		}
	});


}

function variableToValue(debugSession: VScriptDebugSession, value: string, char: string): IBasicType
{
	switch(char)
	{
		case 'i':
		case 'f':
			return Number(value);
		case 'b':
			return value === "true";
		case 's':
			return value;
		case 'a':
		case 't':
		case 'r':
		case 'x':
		case 'y':
			return getStructShortRepresentation(debugSession, value, char);
		case 'fn':
			return "function";
		case 'g':
			return "generator";
		case 'h':
			return "thread";
		case 'u':
			return "userdata";
		default:
			return value;
	}
}

// TODO make this function put the already parsed data in variables map, so that we don't have to parse some stuff twice when responding to variables request.
function getStructShortRepresentation(debugSession: VScriptDebugSession, serverRef: any, type: string): string
{
	let isFirstElement = true;
	let contents = "";
	let length = 0;
	let parsedElementCount = 0;
	for(let obj of debugSession.currentParsedReferences)
	{
		if(obj['$']['ref']!==String(serverRef)) {continue;}
		//if(!obj['e']) {return "";}

		let objTable = obj['e'];
		if(objTable)
		{
			length = objTable.length;
			for(let element of objTable)
			{
				if(parsedElementCount >= debugSession.maxShortData) // we reached the max count.
				{
					contents += ", ...";
					break;
				}
				let elementtype = element['$']['vt'];
				let value = element['$']['v'];

				if(type==='a') {value = "";}
				if(type==='t')
				{
					let keyvalue = element['$']['kv'];
					let keytype = element['$']['kt'];

					switch(keytype) {
						case 's':
							value = keyvalue + " = "; break;
						case 'a':
							value = "Array [...] = "; break;
						case 't':
							value = "Table {...} = "; break;
						case 'r':
							value = "[REFERENCE] = "; break;
						case 'x':
							if(isVariableEHandle(debugSession.currentParsedReferences, Number(element['$']['kv'])))
							{
								value = "[Entity handle] = ";
							}
							else
							{
								value = "[Object] = ";
							}
							break;
						case 'y':
							value = "[Class] = "; break;
						case 'fn':
							value = "[Function] = "; break;
						case 'h':
							value = "[Thread] = "; break;
						case 'g':
							value = "[Function generator] = "; break;
						case 'u':
							value = "[Userdata] = "; break;
						default:
							value = keyvalue.toString() + " = ";
							break;
					}
				}
				switch (elementtype) {
					case 's':
						value = value+"\""+element['$']['v']+"\""; break;
					case 'a':
						value = value+"Array [...]"; break;
					case 't':
						value = value+"Table {...}"; break;
					case 'r':
						value = value+"REFERENCE"; break;
					case 'x':
						// objects sometimes have a typeof key, use it instead if available.
						if(isVariableEHandle(debugSession.currentParsedReferences, Number(element['$']['v'])))
						{
							value = value+"Entity handle";
						}
						else
						{
							for(let obj of debugSession.currentParsedReferences)
							{
								if(obj['$']['ref'] === element['$']['v'])
								{
									if(obj['$']['typeof'])
									{
										value = value+obj['typeof'];
									}
									else
									{
										value = value+"Object";
									}
								}
							}
						}
						break;
					case 'y':
						value = value+"Class"; break;
					case 'fn':
						value = value+"Function"; break;
					case 'h':
						value = value+"Thread"; break;
					case 'g':
						value = value+"Function generator"; break;
					case 'u':
						value = value+"Userdata"; break;
					default:
						value = value+element['$']['v'];
						break;
				}
				if(isFirstElement)
				{
					contents+=value;
					isFirstElement=false;
				}
				else
				{
					contents += ", " + value;
				}
				parsedElementCount++;
			}
		}
	}

	switch (type) {
		case 'a':
			return "Array "+"("+length+") "+"["+contents+"]";
		case 't':
			return "Table "+"("+length+") "+"{"+contents+"}";
		case 'r':
			return "REFERENCE";
		case 'x':
			if(isVariableEHandle(debugSession.currentParsedReferences, Number(serverRef)))
			{
				return "Entity handle";
			}
			// objects sometimes have a typeof key, use it instead if available.
			for(let obj of debugSession.currentParsedReferences)
			{
				if(obj['$']['ref'] !== String(serverRef)) {continue;}
				if(!obj['$']['typeof']) {continue;}

				let value = obj['$']['typeof'];

				// if it's a vector...
				if(obj['$']['typeof']==="Vector")
				{
					// display elements of the vector in a simple form. Vector [x, y, z]
					value = "Vector ["+obj['e'][0]['$']['v']+", "+obj['e'][1]['$']['v']+", "+obj['e'][2]['$']['v']+"]";
				}
				return value;
			}
			return "Object";
		case 'y':
			return "Class";
		case 'fn':
			return "Function";
		case 'h':
			return "Thread";
		case 'g':
			return "Function generator";
		case 'u':
			return "Userdata";
		default:
			return `Structure (${type}) {${contents}}`;
	}
}


export function getTableFromReference(debugSession: VScriptDebugSession, objects: any, serverRef: number, path="", limitElements: boolean = false, pushToLocals = true): DebuggerVariable[]
{
	// TODO are these already sorted? maybe we do not need a loop here but just the index.
	if(debugSession.usedVariableReferences.includes(Number(serverRef))) {
		return debugSession.localVariables.get(serverRef+1) || [];
	}

	debugSession.usedVariableReferences.push(Number(serverRef));
	let variables: DebuggerVariable[] = [];
	for(let obj of objects)
	{
		if(obj['$']['ref']!==String(serverRef)) {continue;}
		if(!obj['e']) {return [];}

		let type = obj['$']['type'];
		//let indexCounter = 0;
		//let keys = Array<IDebuggerVariableType>();
		//let values = Array<IDebuggerVariableType>();
		// TODO we probably have some variables here already, instead of clearing everything we can just grab just the missing pieces.
		debugSession.localVariables.set(Number(obj['$']['ref']) + 1, []);
		for(let element of obj['e'])
		{
			let keytype: string = element['$']['kt'];
			let valuetype: string = element['$']['vt'];

			let keyvalue: IBasicType = element['$']['kv'];
			let thevalue: string = element['$']['v'];

			let keyDisplay: DebuggerVariable | undefined;
			if(keyvalue && type!=='a')
			{
				if(isComplexDataType(keytype)) { // table
					let shortValue: IBasicType = variableToValue(debugSession, element['$']['kv'], keytype);
					keyDisplay = new DebuggerVariable("<KEY>", shortValue, keytype);
					keyDisplay.variableReference = Number(element['$']['kv'])+1;

					keyvalue = "[ " + shortValue + " ]";
				}
				else
				{
					keyvalue = variableToValue(debugSession, element['$']['kv'], keytype);
				}
			}

			let newvalue: IBasicType = variableToValue(debugSession, thevalue, valuetype);
			let table = new DebuggerVariable(keyvalue.toString(), newvalue, valuetype);
			table.variablePath = path + keyvalue;

			if(!isNaN(Number(keyvalue))) // if the keyvalue is numeric, so only number then it's an array
			{
				table.variablePath + ']';
			}

			if(isComplexDataType(valuetype)) {
				table.variableReference = Number(thevalue)+1;

				// if the key of the table is structured data, we add it as a child element of that table.
				if(keyDisplay)
				{
					keyDisplay.ownerReference = table.variableReference;
				}
			}
			else
			{
				// add a <KEY> element if the key is a structured data.
				// will use a fake reference if the value is not structured.
				if(keyDisplay)
				{
					keyDisplay.ownerReference = debugSession.virtualReference;
					table.variableReference = debugSession.virtualReference;
					debugSession.virtualReference++;
				}
			}

			table.ownerReference = Number(obj['$']['ref']) + 1;
			if(valuetype==='a')
			{
				table.isIndexed = true;
			}
			else if(valuetype==='x' && isVariableEHandle(objects, Number(thevalue)))
			{
				let dataWatches = debugSession.entityDataWatches.get(table.variableReference);
				let entityDataVariables: Array<DebuggerVariable> = [];
				if(!dataWatches)
				{
					//entityDataVariables = debugSession.setupEntityData(table);
				}
				else
				{
					//entityDataVariables = debugSession.createVariablesFromWatches(dataWatches, table.variableReference, table.variablePath, variablesAcquireDefer);
				}
				variables = variables.concat(entityDataVariables);
			}
			else if(debugSession.hideNativeFunctions && valuetype === 'native function')
			{
				table.hidden = true;
			}
			else if(debugSession.hideClasses && valuetype === 'y')
			{
				table.hidden = true;
			}

			variables.push(table);
			if(pushToLocals)
			{
				pushToMapArray(debugSession.localVariables, table.ownerReference, table);
			}
			if(keyDisplay)
			{
				pushToMapArray(debugSession.localVariables, keyDisplay.ownerReference, keyDisplay);
			}
		}
	}
	return variables;
}