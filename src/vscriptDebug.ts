import * as vscode from 'vscode';
import { workspace, window, Disposable } from 'vscode';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as Net from 'net';
import * as path from 'path';
import { realpathSync } from 'fs';
import { Subject } from 'await-notify';
import {
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent, InvalidatedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from '@vscode/debugadapter';
import {parseString} from 'xml2js';
import {
	IBreakpoint, FileAccessor, IRuntimeBreakpoint,
	DebuggerVariable,
	DebuggerWatch,
	DebuggerState, VScriptVersion, ExceptionInformation, TreeNode, ReferenceVariable, FileReferenceData
} from './customInterfaces';
import { arrayMapToArray, getScriptRootPath, getRelativeScriptPath, convertVariableToDAP } from './utilities';
import { resolveFileReference } from './fileReferences';
import { getTableFromReference, parseReceivedData } from './parsing';
import { addWatch, evaluateWatchRequest, removeWatch } from './watches';
import { evaluateHoverRequest } from './hover';
import xmlFormat from 'xml-formatter';

interface IAttachRequestArguments extends DebugProtocol.LaunchRequestArguments {
	ip?: string;
	engineVersion?: string;
	additionalScriptDirectories?: Array<string>;
	enableDebugLogging?: boolean;
}

enum ProgressIconState {
	hidden = 0,
	receiving = 1,
	parsing = 2
}

// debug adapter instance.
export class VScriptDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	public static threadID = 1;

	private _cancelledProgressId: string | undefined = undefined;
	static config = vscode.workspace.getConfiguration('VScriptDebugger');
	public socket?: Net.Socket = new Net.Socket();

	// Variables and watches
	public localVariables = new Map<number, Array<DebuggerVariable>>();
	public rootVariables: DebuggerVariable[] = Array<DebuggerVariable>();
	public rootTableReference: number = -1;
	public usedVariableReferences: number[] = [0]; // keeps track of gathered variablWe references to prevent infinite recursion.
	public referenceTree: TreeNode<ReferenceVariable> = {element: {reference: 0, firstName: "@root@", variableType: "r"}, children: [], depth: 0, parent: undefined};
	public referenceVariablePath = new Map<number, string>();
	public watches = Array<DebuggerWatch>();
	public watchesThisStep = Array<number>();
	public entityDataWatches = new Map<number, Array<DebuggerWatch>>(); // could use the main one technically, but reserving one for this purpose should be just more efficient
	public usedVariableReferencesEnt: number[] = Array<number>();
	public visitedTreeElements = Array<number>();
	public currentParsedReferences: any;
	private _variableHandles = new Handles<'locals' | 'root' | 'closure'>();

	// Files
	public resolvedFileReferences = new Map<string, FileReferenceData>(); // maps pure filename to absolute path, used for games that don't give full path. Resets on resume.
	public currentWorkPath: string = "";
	public additionalScriptDirectories = Array<string>();
	private _notifiedFileBreakpoints = Array<string>();

	// Debugger
	public debuggerState = DebuggerState.disconnected;
	public exceptionInfo = {} as ExceptionInformation;
	public currentFrameID: number = -1;
	public startingFrameID: number = -1;
	public stacktraces = new Array<StackFrame>();
	public watchEvaluateTimer: ReturnType<typeof setTimeout> | undefined;
	public virtualReference: number = 10000; // starting reference used for variables that need to be assigned one arbirtrarly.
	public evaluateIgnoreInvalidatedRequest = false;
	public scriptVersion = VScriptVersion.squirrel2;
	public watchID: number = 1;
	public entityDataWatchID: number = 1000000;
	public stackFrameID: number = 0;
	public _breakpoints = new Map<string, IBreakpoint[]>();
	private _editDuringDebugWarning: Disposable | undefined;
	private connectionRetries = 1;
	private _configurationDone = new Subject();
	private _cancellationTokens = new Map<number, boolean>();
	private _bufferedData: string = "";
	private _breakpointID: number = 0;
	private _breakpointsRefCount = new Map<[string, number], number>(); // Squirrel2 debug engine won't recognize paths when adding breakpoints, if we add more than one and then remove just one from the same file name it will be removed for all of them.
	private progressStatus: vscode.StatusBarItem;

	// Settings
	public resumeOnExceptions: boolean = false;
	public resumeTimer: ReturnType<typeof setTimeout> | undefined; // timer used as workaround for resuming issues in Squirrel 2 games.
	public hideNativeFunctions = true;
	public hideClasses = false;
	public maxShortData: number = 4;
	private _debugPort: number = 1234;
	private _debugIP: string = "localhost";
	private _usingAttachIp = false;
	private _enableDebugLogging = false;

	// Saved responses
	private attachResponse: DebugProtocol.AttachResponse | undefined;

	private updateProgressBar(state: ProgressIconState)
	{
		switch (state) {
			case ProgressIconState.hidden:
				this.progressStatus.hide();
				break;
			case ProgressIconState.receiving:
				this.progressStatus.text = "$(loading~spin) VScript debugger: Receiving data";
				this.progressStatus.tooltip = "The debug server is in process of sending the current state, it should not take too long (being stuck in this state might be an extension issue).";
				this.progressStatus.show();
				break;
			case ProgressIconState.parsing:
				this.progressStatus.text = "$(loading~spin) VScript debugger: Parsing data";
				this.progressStatus.tooltip = "The extension is parsing the data sent by the server.";
				this.progressStatus.show();
				break;
		}
	}

	private setResumeTimeout()
	{
		if(this.scriptVersion < VScriptVersion.squirrel3)
		{
			if(VScriptDebugSession.config.get("resumeWorkaround"))
			{
				const timeout: number = VScriptDebugSession.config.get<number>("resumeWorkaroundTimeout") || 2000;
				this.resumeTimer = setTimeout(() => {
					this.resumeExecution();
					this.sendEvent(new OutputEvent("Debugger didn't respond in: "+ parseFloat(String(timeout/1000)).toFixed(2)+ " second(s) after stepping. Automatically resuming...\n", "console"));
				}, timeout);
			}
		}
	}

	private updateConfiguration()
	{
		VScriptDebugSession.config = workspace.getConfiguration('VScriptDebugger');

		// update IP and Port
		if(!this._usingAttachIp)
		{
			this._debugPort = VScriptDebugSession.config.get<number>('connectionPort') || 1234;
			this._debugIP = VScriptDebugSession.config.get<string>('connectionIP') || "localhost";
		}

		// other
		this.maxShortData = VScriptDebugSession.config.get<number>('maximumStructureShortRepresentationValues') || 4;
		const hideNativeFunctions = VScriptDebugSession.config.get<boolean>('hideNativeFunctions');
		if(hideNativeFunctions === undefined)
		{
			this.hideNativeFunctions = true;
		}
		else
		{
			this.hideNativeFunctions = hideNativeFunctions;
		}
		this.hideClasses = VScriptDebugSession.config.get<boolean>('hideClassDefinitions') || false;
	}

	private onContentChangedWarning(changeEvent: vscode.TextDocumentChangeEvent)
	{
		if(this.debuggerState === DebuggerState.stopped && changeEvent.document.fileName.endsWith(".nut"))
		{
			window.showInformationMessage("Document contents were changed during a debugging session, debugger might be inaccurate until scripts are reloaded." , "OK");
			if(this._editDuringDebugWarning)
			{
				this._editDuringDebugWarning.dispose();
			}
		}
	}

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super();

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.updateConfiguration();

		this.attemptConnect = this.attemptConnect.bind(this);


		this.onContentChangedWarning = this.onContentChangedWarning.bind(this);
		// handle configuration change event
		workspace.onDidChangeConfiguration((changeEvent: vscode.ConfigurationChangeEvent) => {

			if (changeEvent.affectsConfiguration("VScriptDebugger"))
			{
				// update "Get root table"
				//if(this.scriptVersion === VScriptVersion.squirrel2) // only for squirrel2 we want to affect it globally.
				//{
					if(VScriptDebugSession.config.get('displayRootTable'))
					{
						addWatch(this, 0, "clone ::getroottable()", "", -1);
					}
					else
					{
						removeWatch(this, 0, false);
					}
				//}

				this.updateConfiguration();
			}
		});

		// socket callback setup.
		this.onRecieveData = this.onRecieveData.bind(this);
		this.socket?.on('connect', () => {
			this.resetState();
			this._breakpoints.clear();
			this.socket?.write('rd\n', 'ascii', () => this.sendEvent(new ProgressEndEvent("1001")));
			this.debuggerState = DebuggerState.ready;
			this.currentWorkPath = getScriptRootPath();
			this._notifiedFileBreakpoints = [];

			if(VScriptDebugSession.config.get('displayRootTable'))
			{
				this.watches.push(addWatch(this, 0, "clone ::getroottable()", "getroottable()", -1)); // the clone is needed here since the debug serialization script won't build references if the table is the original roottable.
			}

			if(this.attachResponse)
			{
				this.sendResponse(this.attachResponse);
			}
		});
		this.socket?.on('error', async (error: Error) => {
			this.socket?.end();
			if(this.connectionRetries <= 1) // setup a progress bar for first try.
			{
				let progress: DebugProtocol.ProgressStartEvent = new ProgressStartEvent("1001", `Waiting for game on ${this._debugIP}`, `${this.connectionRetries}/10 retries`);
				progress.body.cancellable = true;
				this.sendEvent(progress);
				this.attemptConnect();
				this.connectionRetries++;
			}
			else if(this.connectionRetries > 1 && this.connectionRetries<=10)
			{
				setTimeout(() => {
					this.sendEvent(new ProgressUpdateEvent("1001", `${this.connectionRetries}/10 retries`));
					if(this._cancelledProgressId === "1001")
					{
						this.sendEvent(new ProgressEndEvent("1001"));
						this._cancelledProgressId = undefined;
						this.connectionRetries = 1;
						if(this.attachResponse)
						{
							this.sendErrorResponse(this.attachResponse, {
								id: 1001,
								format: 'Connection aborted',
								showUser: false
							});
						}
						this.sendEvent(new TerminatedEvent());
						return;
					}
					this.attemptConnect();
					this.connectionRetries++;
				}, 1500);
			}
			else
			{
				this.sendEvent(new ProgressEndEvent("1001"));
				if(this.attachResponse)
				{
					this.sendErrorResponse(this.attachResponse, {
						id: 1001,
						format: `Connection to game failed after multiple retries.`,
						showUser: true
					});
				}
				this.resetState();
			}

		});
		this.socket?.on('data', this.onRecieveData);
		this.socket?.on('end', () => {
			this.sendEvent(new TerminatedEvent());
			this.debuggerState = DebuggerState.disconnected;
			this.connectionRetries = 1;
			this._usingAttachIp = false;
			this.progressStatus.dispose();
		});

		this._editDuringDebugWarning = workspace.onDidChangeTextDocument(this.onContentChangedWarning);

		this.progressStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
		this.progressStatus.hide();
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};
		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;

		// no support for repl completions yet, maybe later when we add telnet.
		response.body.supportsCompletionsRequest = false;

		response.body.supportsCancelRequest = true;
		response.body.supportsBreakpointLocationsRequest = true;

		// we don't support step in target.
		response.body.supportsStepInTargetsRequest = false;

		// define automatic breakpoints for exceptions.
		response.body.supportsExceptionFilterOptions = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'allExceptions',
				label: "All exceptions",
				description: `Break on all exceptions.`,
				default: true, // the default behavior is like that in the vscript debug server, disabling it is merely a workaround.
				supportsCondition: false,
			}
		];

		response.body.supportsExceptionInfoRequest = true;
		// we can't set variables
		response.body.supportsSetVariable = false;
		response.body.supportsSetExpression = false;
		// we don't support disassembling or accessing memory
		response.body.supportsDisassembleRequest = false;
		response.body.supportsSteppingGranularity = false;
		response.body.supportsInstructionBreakpoints = false;
		response.body.supportsReadMemoryRequest = false;
		response.body.supportsWriteMemoryRequest = false;

		response.body.supportSuspendDebuggee = false;
		response.body.supportsFunctionBreakpoints = false;
		response.body.supportsDelayedStackTraceLoading = true;

		// maybe once we get telnet in we could automatically reattach the debugger? for now don't allow restarts.
		response.body.supportsRestartRequest = false;

		// we're only attaching so we don't get to terminate or suspend the game itself.
		response.body.supportSuspendDebuggee = false;
		response.body.supportTerminateDebuggee = false;

		// server doesn't support any special types of breakpoints..
		response.body.supportsInstructionBreakpoints = false;
		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsHitConditionalBreakpoints = false;
		response.body.supportsDataBreakpoints = false;
		response.body.supportsLogPoints = false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	public resetState(): void
	{
		this._bufferedData = "";
		this.currentFrameID = 0;
		this.startingFrameID = -1;
		this.resolvedFileReferences.clear();
		this._variableHandles.reset();
		this.virtualReference = 10000;
		this.visitedTreeElements = [];
		if(!(VScriptDebugSession.config.get<boolean>("rememberFileReferencesDuringSession") || false))
		{
			this.resetFileReferences();
		}

		if(this._editDuringDebugWarning)
		{
			this._editDuringDebugWarning.dispose();
		}
		this._editDuringDebugWarning = workspace.onDidChangeTextDocument(this.onContentChangedWarning);
	}

	public resetFileReferences()
	{
		this.resolvedFileReferences.clear();
	}

	public async cleanupUnusedWatches()
	{
		for(let watch of this.watches)
		{
			if(watch.id===0) {continue;}

			let isObsolete = true;
			for(let verifiedWatchID of this.watchesThisStep)
			{
				if(watch.id === verifiedWatchID)
				{
					isObsolete = false;
					break;
				}
			}

			if(isObsolete)
			{
				removeWatch(this, watch.id, true);
			}
		}
		this.watchesThisStep = [];
	}

	private onRecieveData(data: string)
	{
		if(data===undefined) { return; }
		this.updateProgressBar(ProgressIconState.receiving);
		this._bufferedData = this._bufferedData + data;
		if(!this._bufferedData.endsWith("\r\n")) {return;}
		try
		{
			this.updateProgressBar(ProgressIconState.parsing);
			this.currentWorkPath = getScriptRootPath();
			this.stackFrameID = 0;
			// Split in case too much data arrives at once.
			for(let dataPackage of this._bufferedData.split("\r\n"))
			{
				if (dataPackage.length > 0)
				{
					if(this._enableDebugLogging)
					{
						let formatted: string = xmlFormat(this._bufferedData.trimEnd(), {lineSeparator: "\n"});
						this.sendEvent(new OutputEvent("Received XML from game:\n" + formatted + "\n", 'console'));
					}
					parseReceivedData(this, dataPackage);
				}
			}
			this.updateProgressBar(ProgressIconState.hidden);
		}
		catch
		{
			window.showErrorMessage("An error has occured while receiving and parsing data from the debug server on the current step, information cannot be displayed.\n");
			let stopEvent = new StoppedEvent("step", VScriptDebugSession.threadID, "Stopped due to extension error");
			this.sendEvent(stopEvent);
		}

		this._bufferedData = "";
		this.usedVariableReferences = [0];
		this.visitedTreeElements = [];
		// warning for changes during debugging session
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void
	{
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void
	{
		//console.log(`disconnectRequest suspend: ${args.suspendDebuggee}, terminate: ${args.terminateDebuggee}`);
		this.socket?.write("tr\n", "ascii", () => {
			console.log("sent terminate request");
			this.debuggerState = DebuggerState.disconnected;
		});
		this.socket?.end();
		this.sendEvent(new TerminatedEvent());
		this.sendResponse(response);
	}


	protected async attachRequest(response: DebugProtocol.AttachResponse, args: IAttachRequestArguments)
	{
		this.attachResponse = response;
		if(args.ip)
		{
			this._debugIP = args.ip;
			this._usingAttachIp = true;
		}// else use the default config.
		if(args.enableDebugLogging !== undefined)
		{
			this._enableDebugLogging = args.enableDebugLogging;
		}
		switch (args.engineVersion?.toLowerCase()) {
			case "squirrel2":
				this.scriptVersion = VScriptVersion.squirrel2;
				break;
			case "squirrel3":
				this.scriptVersion = VScriptVersion.squirrel3;
				break;
			default:
				// default is sq2
				break;
		}

		const rootPath = getScriptRootPath();
		if(rootPath !== "" && args.additionalScriptDirectories)
		{
			// filter elements that are already subpaths of the root directory so we don't get duplicates.
			let allPaths = args.additionalScriptDirectories.concat(rootPath);
			this.additionalScriptDirectories = args.additionalScriptDirectories.filter((element, index) => {
				for(let [innerIndex, existingElement] of (allPaths).entries())
				{
					if(innerIndex === index) {continue;}

					let relativePath = path.relative(existingElement, element);
					if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath))
					{
						return false;
					}
					// check if they point to the same thing.
					const path1 = realpathSync.native(existingElement);
					const path2 = realpathSync.native(element);
					if (path1 === path2) {return false;}
				}
				return true;
			});
		}
		this.attemptConnect();
	}
	private attemptConnect(): void
	{
		this.socket?.connect({port: this._debugPort, host: this._debugIP});
	}

	protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
		this.sendResponse(response);
	}

	private sendRemoveBreakpoint(src: string, line: Number)
	{
		src = src.replace(/\\/g, "/");
		let message: string = `rb 0x${line.toString(16)}:${src}\n`;
		this.debugPrint("Sendind message: " + message);
		this.socket?.write(message, "ascii");
	}

	private async sendAddBreakpoint(src: string, line: Number)
	{
		// line numbers need to be given in hex.
		src = src.replace(/\\/g, "/");
		let message: string = `ab 0x${line.toString(16)}:${src}\n`;
		this.debugPrint("Sendind message: " + message);
		this.socket?.write(message, "ascii");
	}

	private verifyBreakpoint(bp: IRuntimeBreakpoint): Promise<IRuntimeBreakpoint>
	{
		return new Promise((resolve, reject) => {
			let bufferedData: string = "";

			let verifyBpHandler = function(this: VScriptDebugSession, data)
			{
				// <addbreakpoint line="7" src="debugger.nut"/>
				bufferedData+=data;
				if(!bufferedData.endsWith("\r\n")) {return;}

				parseString(bufferedData, (err,result) => {
					if(result['addbreakpoint'] === undefined)
					{
						reject();
						return;
					}

					bp.line = Number(result['addbreakpoint']['$']['line']);
					bp.verified = true;
					//const src: string = result['addbreakpoint']['$']['src'];
					//console.log("parsed data for bp: "+src+" : "+bp.line);

					this.socket?.off("data", verifyBpHandler);
					resolve(bp);
				});
			};

			verifyBpHandler = verifyBpHandler.bind(this);
			this.socket?.on("data", verifyBpHandler);
		});
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		if(!args.source.path)
		{
			response.body = {
				breakpoints: []
			};
			this.sendResponse(response);
			return;
		}

		let sendBpPromise = new Promise<void>( (resolve, reject) => {
			if(this.debuggerState === DebuggerState.disconnected) // if we're not connected yet then wait for full connection before sending breakpoints.
			{
				this.socket?.once("connect", () => {
					resolve();
				});
			}
			else // if we're already connected resolve the promise.
			{
				resolve();
			}
		});

		sendBpPromise.then(async () => {
			let bpPath = getRelativeScriptPath(args.source.path!) as string; // need the exclamation ?? we're checking the source path at the beginning, hello ts???
			bpPath = bpPath.replace(/\\/g, "/");
			const breakpoints = args.breakpoints || [];

			let originalBps = this._breakpoints.get(bpPath) || [];
			this._breakpoints.set(bpPath, new Array<IRuntimeBreakpoint>()); // empty the array of breakpoints for this file

			const actualBreakpoints = breakpoints.map(breakpoint => {

				let existingBp = originalBps.find(searchedBp => searchedBp.line === breakpoint.line);
				let isVerified = true;
				if(existingBp)
				{
					isVerified = existingBp.verified;
				}
				const bp: IRuntimeBreakpoint = { verified: isVerified, line: breakpoint.line, id: this._breakpointID++ };
				let bps = this._breakpoints.get(bpPath);
				if (!bps) {
					bps = new Array<IRuntimeBreakpoint>();
					this._breakpoints.set(bpPath, bps);
				}
				bps.push(bp);
				let dapBp = new Breakpoint(bp.verified, bp.line);
				dapBp.setId(bp.id);

				return dapBp;
			});

			let bpsForRemoval = originalBps?.filter(element => {
				for(let inner of this._breakpoints.get(bpPath)!)
				{
					if(inner.line === element.line) {return false;}
				}
				return true;
			});
			let bpsForInclusion = this._breakpoints.get(bpPath)?.filter(element => {
				for(let inner of originalBps!)
				{
					if(inner.line === element.line) {
						return false;
					}
				}
				return true;
			});

			// TODO: refactor to do it in one line above.
			if(bpsForRemoval)
			{
				for(let bp of bpsForRemoval)
				{
					//if(this.scriptVersion === VScriptVersion.squirrel2)
					//{
					let refCount: number | undefined = this._breakpointsRefCount.get([path.basename(bpPath), bp.line]);
					if(!refCount)
					{
						refCount = 0;
					}
					refCount--;
					if(refCount <= 0)
					{
						this.sendRemoveBreakpoint(bpPath, bp.line);
						this._breakpointsRefCount.delete([path.basename(bpPath), bp.line]);
					}
					else
					{
						this._breakpointsRefCount.set([path.basename(bpPath),bp.line], refCount);
					}

					//}
					//else
					//{
					//	this.sendRemoveBreakpoint(bpPath, bp.line);
					//}
				}
			}

			if(bpsForInclusion)
			{
				for(let bp of bpsForInclusion)
				{
					this.sendAddBreakpoint(bpPath, bp.line);
					//if(this.scriptVersion === VScriptVersion.squirrel2)
					//{
					let wasNotified: boolean = this._notifiedFileBreakpoints.includes(path.basename(bpPath));
					if(!wasNotified)
					{
						this._notifiedFileBreakpoints.push(path.basename(bpPath));
						let files = await resolveFileReference(this, path.basename(bpPath), false, false);
						if(Array.isArray(files))
						{
							files = files.map( file => getRelativeScriptPath(file));
							if(files.length > 1)
							{
								let messageString = `Adding breakpoint to this file will cause it to be added to the following files of the same name regardless of the path due to a bug in the engine. [[ ${files.join("; ")} ]] This shouldn't be an issue if you're sure that both of these scripts will not be ran in the same sesion.`;
								window.showWarningMessage(messageString, {modal: false}, {title: "Ok"});

							}
						}
					}
					let refCount: number | undefined = this._breakpointsRefCount.get([path.basename(bpPath), bp.line]);
					if(refCount === undefined)
					{
						refCount = 0;
					}
					refCount++;
					this._breakpointsRefCount.set([path.basename(bpPath), bp.line], refCount);
					//}

				}
			}
			// send back the actual breakpoint positions
			response.body = {
				breakpoints: actualBreakpoints
			};
			this.sendResponse(response);
		});
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {

		if (args.source.path) {
			let filename = getRelativeScriptPath(args.source.path);
			const bps = this._breakpoints.get(filename);
			if(bps)
			{
				response.body = {
					breakpoints: bps.map((bp) => { return { line: bp.line };} )
				};
			}
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {
		this.resumeOnExceptions = true;

		if (args.filterOptions) {
			for (const filterOption of args.filterOptions) {
				switch (filterOption.filterId) {
					case 'allExceptions':
						this.resumeOnExceptions = false;
						break;
				}
			}
		}

		if (args.filters) {
			if (args.filters.indexOf('allExceptions') >= 0) {
				this.resumeOnExceptions = false;
			}
		}

		this.sendResponse(response);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {

		response.body = {
			exceptionId: '',
			description: this.exceptionInfo.description,
			details: this.exceptionInfo.details,
			breakMode: 'always',
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(VScriptDebugSession.threadID, "main thread"),
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
		const startFrame = args.startFrame || 0;
		let stackFrames = this.stacktraces;

		if(stackFrames)
		{
			let levels = args.levels || stackFrames.length - startFrame;
			if(startFrame+levels > stackFrames.length)
			{
				levels = stackFrames.length - startFrame;
			}
			let frames = stackFrames.slice(startFrame, startFrame+levels+1);
			response.body = {
				stackFrames: frames,
				totalFrames: levels
			};
		}
		else
		{
			response.body = {
				stackFrames: [],
				totalFrames: 0
			};
		}
		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): Promise<void> {
		let scopes: Array<DebugProtocol.Scope> = [];
		this._variableHandles.reset();

		let rootTableNumber = -1;
		if(VScriptDebugSession.config.get("displayRootTable"))
		{
			rootTableNumber = this._variableHandles.create('root');
			scopes.push(new Scope("Root table", rootTableNumber, true));
		}
		const localsNumber = this._variableHandles.create('locals');
		const closureNumber = this._variableHandles.create('closure');
		scopes.push(new Scope("Locals", localsNumber, false));
		scopes.push(new Scope("Closure", closureNumber, false));

		response.body = {
			scopes: scopes
		};
		if(this.startingFrameID === -1)
		{
			this.startingFrameID = args.frameId;
		}
		this.currentFrameID = args.frameId;
		const workFrameID = this.currentFrameID;
		if(this.currentFrameID > 0)
		{
			const framePath = this.stacktraces[this.currentFrameID].source?.path;
			let frameBaseName: string = "";
			if(framePath)
			{
				// if it's nut a .nut then it's doubtful that anything useful will come out of it. Let's not do that to not generate popups
				if(!framePath.endsWith(".nut")) {
					this.sendResponse(response);
					return;
				}

				// if we already have a resolved reference
				for(const [_,value] of this.resolvedFileReferences.entries()) {
					if(value.fullpath === framePath) {
						this.sendResponse(response);
						return;
					}
				}

				// in case the reference is unconfirmed (always a file without the full path)
				frameBaseName = path.basename(framePath);

				const frameRefData: FileReferenceData | undefined = this.resolvedFileReferences.get(frameBaseName);
				// resolve the file reference.
				// await here since we need to wait for everything before sending invalidated event for client to get new stacks.
				await resolveFileReference(this, frameBaseName, true, true).then( (file) => {
					if(typeof file === "string")
					{
						if(!frameRefData)
						{
							this.resolvedFileReferences.set(frameBaseName, {fullpath: file, count: 1});
						}
						else
						{
							frameRefData.count++;
							this.resolvedFileReferences.set(frameBaseName, frameRefData);
						}
						this.stacktraces[workFrameID].source = this.createSource(file);
						// fire an invalidated event in order to request the stack to update to current file.
						this.sendEvent(new InvalidatedEvent(['stacks'], VScriptDebugSession.threadID, args.frameId));
					}
				});
			}
		}
		this.sendResponse(response);
	}

	protected getRootVariables(): DebuggerVariable[]
	{
		let vs: DebuggerVariable[];
		if(this.rootVariables.length > 0)
		{
			vs = this.rootVariables;
		}
		else
		{
			vs = [];
			if(this.rootTableReference !== -1)
			{
				this.rootVariables = getTableFromReference(this, this.currentParsedReferences, this.rootTableReference, "", false, false);
			//.filter(element => element.frameId === this._currentFrameID);
				vs = this.rootVariables;
			}
		}
		return vs;
	}

	/**
	 * Get variables based on a reference >= 0 if they're not parsed they will be here and cached for later.
	 * @param serverref Server side variable reference number (client - 1)
	 * @returns Array of variables
	 */
	public getVariablesFromReference(serverref: number): Array<DebuggerVariable> | undefined
	{
		if(serverref===0)
		{
			return this.localVariables.get(0);
		}
		else if(serverref === this.rootTableReference)
		{
			return this.getRootVariables();
		}
		let vs: Array<DebuggerVariable>;
		vs = getTableFromReference(this, this.currentParsedReferences, serverref, "");
		return vs;
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		let start = args.start || 0;
		let count = args.count;
		let vs: DebuggerVariable[] | undefined;
		//to not overcomplicate too much we'll just parse everything from the reference,
		if(this._variableHandles.get(args.variablesReference)==='locals')
		{
			vs = this.localVariables.get(0);
			if(vs)
			{
				vs = vs.filter(element => element.frameId === this.currentFrameID);
			}
		}
		else if(this._variableHandles.get(args.variablesReference)==='root')
		{
			// parse root variables
			// this scope is marked as 'expensive' so we don't need to parse it right away when recieving data, only when we need it here.
			vs = this.getRootVariables();
		}
		else if(this._variableHandles.get(args.variablesReference)==='closure') // closure is 'this'
		{
			const thisReference = this.localVariables.get(0)?.find(e => e.name === "this" && e.frameId === this.currentFrameID)?.variableReference;
			if(thisReference === undefined)
			{
				response.body.variables = [];
				this.sendResponse(response);
				return;
			}
			vs = this.localVariables.get(thisReference);
			if(!vs || vs.length <= 0)
			{
				vs = getTableFromReference(this, this.currentParsedReferences, thisReference-1, "", false, true);
				if(!vs || vs.length <= 0)
				{
					vs = this.getRootVariables();
				}
			}
		}
		else
		{
			// child references are not all parsed yet, let's do that now.
			// there are some exceptions, (some child elements get created earlier since it's more efficient, and they get put into the locals table)
			let existingElements = this.localVariables.get(args.variablesReference);
			if(this.rootTableReference >= 0 && args.variablesReference === this.rootTableReference) // mainly used for 'this' in global scopes.
			{
				vs = this.getRootVariables();
			}
			else
			{
				vs = getTableFromReference(this, this.currentParsedReferences, args.variablesReference-1, "");
				//vs = this.getVariablesFromReference(args.variablesReference-1);
			}
			if(existingElements)
			{
				vs = vs.concat(existingElements.filter(element => {
					return !vs?.includes(element); // get rid of possible duplicates.
				}));
			}
		}
		if(!count)
		{
			count = vs!.length - start;
		}
		response.body = {
			variables: vs!.slice(start, start+count)
						.filter(element => !element.hidden)
						.map(element => convertVariableToDAP(element))
						.sort((a,b) => {
							if(!isNaN(Number(a.name)) && !isNaN(Number(b.name))) {return 0;} // don't sort numerics
							else {return a.name.localeCompare(b.name);} // sort alphabetically
						})
		};
		this.sendResponse(response);
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.resumeExecution();
		this.sendResponse(response);
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request | undefined): void {
		this.socket?.write("sp\n", 'ascii');
		this.debugPrint("Sending 'sp' request (suspend)");
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.socket?.write("go\n", "ascii");
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		if(this.debuggerState === DebuggerState.errored || this.debuggerState === DebuggerState.preResume) { // If we stopped on a exception then let this request continue the execution, as we can't do anything else anymore.
			this.resumeExecution();
		}
		else {
			this.socket?.write("so\n", "ascii");
			this.debugPrint("Sending 'so' message (step over)");
			this.setResumeTimeout();
		}
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this.socket?.write("so\n", "ascii");
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		if(this.debuggerState === DebuggerState.errored || this.debuggerState === DebuggerState.preResume) { // If we stopped on a exception then let this request continue the execution, as we can't do anything else anymore.
			this.resumeExecution();
		}
		else {
			this.socket?.write("si\n", "ascii");
			this.debugPrint("Sending 'si' message (step-in)");
			this.setResumeTimeout();
		}
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.stepOut();
		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

		let reply: string | undefined;

		switch (args.context) {
			// console input
			case 'repl':
				switch(args.expression)
				{
					case "rd":
					case "ready":
						this.socket?.write("rd\n", "ascii");
						reply = "sending ready request";
						break;
					case "go":
					case "resume":
						this.resumeExecution();
						reply = "sending resume request";
						break;
					case "sr":
					case "stepout":
						this.stepOut();
						reply = "sending step out request";
						break;
					case "sp":
					case "suspend":
						this.socket?.write("sp\n", "ascii");
						reply = "sending suspend request";
						break;
					case "so":
					case "step":
						this.socket?.write("so\n", "ascii");
						reply = "sending step over request";
						break;
					case "si":
					case "stepin":
						this.socket?.write("si\n", "ascii");
						reply = "sending step into request";
						break;
					case "ua":
					case "update":
						if(this.scriptVersion === VScriptVersion.squirrel3)
						{
							this.socket?.write("ua\n", "ascii");
							reply = "sending update request";
						}
						else
						{
							reply = "update request is not supported for this script engine version.";
						}
						break;
					case "di":
					case "disable":
						this.socket?.write("di\n", "ascii");
						reply = "sending disable request";
						break;
				}

				break;
			case 'watch':
				let newResponse = evaluateWatchRequest(this, args, response);
				if(newResponse)
				{
					this.sendResponse(newResponse);
				}
				else
				{
					this.sendResponse(response);
				}
				break;
			case 'hover':
				evaluateHoverRequest(this, args, response);
				break;
			default:
				break;
		}

		response.body = {
			result: reply || "unknown command",
			variablesReference: 0
		};

		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancellationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId= args.progressId;
		}
	}

	public stepOut(): void
	{
		if(this.stacktraces.length > 1)
		{
			this.socket?.write("sr\n", "ascii");
			this.debugPrint("Sending 'sr' message (step return)");
		}
		else
		{
			this.resumeExecution();
		}
	}

	public resumeExecution(): void
	{
		let watches = arrayMapToArray(this.entityDataWatches);
		const dontForgetFiles = VScriptDebugSession.config.get<boolean>("rememberFileReferencesDuringSession") || false;
		if(!dontForgetFiles)
		{
			this.resolvedFileReferences.clear();
		}
		for(let watch of watches)
		{
			removeWatch(this, watch.id, false);
		}
		this.entityDataWatches.clear();
		this.entityDataWatchID = 1000000;

		if(this.debuggerState === DebuggerState.errored)
		{
			this.socket?.write("rd\n", "ascii");
			this.debugPrint("Sending 'rd' message (ready)");
		}
		this.socket?.write("go\n", "ascii");
		this.debugPrint("Sending 'go' message (resume)");
		this.debuggerState = DebuggerState.ready;
	}

	public createSource(filePath: string): DebugProtocol.Source
	{
		return new Source(path.basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'vscript-adapter-data');
	}

	/**
	 * Sends an update request, workarounds issues that could happen due to this.
	 */
	public sendUpdateRequest()
	{
		if(this.watchEvaluateTimer)
		{
			clearTimeout(this.watchEvaluateTimer);
		}
		this.watchEvaluateTimer = setTimeout(() => {
			this.evaluateIgnoreInvalidatedRequest = true;
			this.debugPrint("Sending 'ua' request (update)");
			this.socket?.write("ua\n", "ascii");
		}, 100);
	}

	public debugPrint(message: string)
	{
		if(this._enableDebugLogging)
		{
			this.sendEvent(new OutputEvent(message, 'console'));
		}
	}
}

