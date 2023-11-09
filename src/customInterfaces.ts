'use strict';

import { DebugProtocol } from '@vscode/debugprotocol';

export const squirrelReservedKeywords = [
	"base", "break", "case", "catch", "class", "clone",
	"continue", "const", "default", "delete", "else", "enum",
	"extends", "for", "foreach", "function", "if", "in",
	"local", "null", "resume", "return", "switch", "this",
	"throw", "try", "typeof", "while", "yield", "constructor",
	"instanceof", "true", "false", "static", "__LINE__", "__FILE__",
	"rawcall"
];

export interface TreeNode<T> {
	element: T;
	parent?: TreeNode<T>;
	children: Array<TreeNode<T>>;
	depth: number;
}
export interface ReferenceVariable {
	reference: number;
	firstName: string;
	variableType: string;
}

export interface FileReferenceData {
	fullpath: string;
	count: number;
}

interface IQueue<T> {
	enqueue(element: T);
	dequeue();
}

export class Queue<T> implements IQueue<T> {
	private storage: T[] = [];

	constructor()
	{
		this.storage = [];
	}

	enqueue(element: T)
	{
		this.storage.push(element);
	}
	dequeue()
	{
		return this.storage.shift();
	}
	length(): number
	{
		return this.storage.length;
	}
}

export interface IBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export interface FileAccessor {
	isWindows: boolean;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export type IDebuggerVariableType = number | boolean | string | DebuggerVariable[];
export type IBasicType = number | string | boolean;

export interface ExceptionInformation {
	description: string;
	details: DebugProtocol.ExceptionDetails;
}

export interface IRuntimeBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

export enum DebuggerState {
	runnning = 1,
	stopped = 2,
	errored = 3,
	preResume = 4,
	ready = 5,
	disconnected = 6
}

export enum VScriptVersion {
	squirrel2 = 0,
	squirrel3 = 1
}

export class DebuggerVariable {
	_variableReference: number;
	ownerReference: number;
	isIndexed: boolean;
	nameType: string; // used for tables.
	variablePath: string = "";
	presentationHint: DebugProtocol.VariablePresentationHint | undefined;
	frameId = 0;
	hidden: boolean = false;

	public get value() {
		return this._value;
	}

	public set value(value: IDebuggerVariableType) {
		this._value = value;
	}

	public get type() {
		return this._type;
	}

	public set variableReference(refid: number) {
		this._variableReference = refid;
	}

	public get variableReference() {
		return this._variableReference;
	}

	constructor(public name: string, private _value: IDebuggerVariableType, private _type: string = typeof _value) {
		this._variableReference = 0;
		this.ownerReference = 0;
		this.isIndexed = false;
		this.nameType = "s";
	}
}

export enum WatchStatus {
	ok = 0,
	error = 1
}

export class DebuggerWatch {
	values: IDebuggerVariableType[] = [];
	variableReference: number = 0;
	type: string = "";
	status: WatchStatus[] = [];

	// used for entity data
	holderReference: number = 0;
	displayName: string = ""; // used only for entity data display for now.
	hidden: boolean = false; // will be true if used internally for gathering properties of entities.
	frameId = 0;
	isValid = false;

	constructor(public id: number, public expression: string)
	{}
}

export class Deferred {
	resolve;
	reject;
	promise: Promise<any>;
	constructor()
	{
		this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
	}
}
