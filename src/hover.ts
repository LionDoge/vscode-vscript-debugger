'use strict';

import * as vscode from 'vscode';
import { TreeNode, ReferenceVariable, DebuggerVariable } from './customInterfaces';
import { referenceTreeBFS } from './parsing';
import { VScriptDebugSession } from './vscriptDebug';
import { DebugProtocol } from '@vscode/debugprotocol';
import { convertVariableToDAP } from './utilities';
import { squirrelReservedKeywords } from './customInterfaces';

// hover.ts registers the custom hover and inline evaluation functions.
export function evaluateHoverRequest(debugSession: VScriptDebugSession, args: DebugProtocol.EvaluateArguments, response: DebugProtocol.EvaluateResponse)
{
	let isFirstVariableGlobal = false;
	let exp = args.expression;

	if(!isNaN(Number(exp))) // if the hovered expression is just a numer alone then return itself, otherwise it would try to search the tree and return random stuff.
	{
		response.body = {
			result: exp,
			type: "number",
			variablesReference: 0
		};
		debugSession.sendResponse(response);
		return;
	}
	if(args.expression.charAt(0)===":")
	{
		isFirstVariableGlobal = true;
		exp = exp.slice(1);
	}
	let names = exp.split(".");
	let currentNode = debugSession.referenceTree;
	let lastResult: TreeNode<ReferenceVariable> | undefined = debugSession.referenceTree;
	let searchName = names.pop();
	if(!searchName)
	{
		return;
	}
	// search variables top to bottom in an order.
	// we will search leading variable names that will get us to the variable we want (last one in sequence)
	let variableReference = 0;
	let idx = 0;

	if(isFirstVariableGlobal && debugSession.rootTableReference >= 0)
	{
		lastResult = referenceTreeBFS(currentNode, node => (node.element.reference === debugSession.rootTableReference));
		if(lastResult)
		{
			currentNode = lastResult;
		}
		// else stay at root table.
	}

	for(let variable of names)
	{
		if(squirrelReservedKeywords.includes(variable)) {idx++; continue;}
		lastResult = referenceTreeBFS(currentNode, node => (node.element.firstName === variable));
		if(lastResult)
		{
			currentNode = lastResult;
			variableReference = currentNode.element.reference;
		}
		idx++;
	}
	let variable: DebuggerVariable | undefined;

	// in case we haven't found the table containing the variable (because for example one of the variable didn't get noticed) we will go through the shortest path.
	referenceTreeBFS(currentNode, (node) => {
		variable = debugSession.getVariablesFromReference(node.element.reference)?.find(e => e.name === searchName);
		if(variable)
		{
			return true;
		}
		return false;
	});

	if(!variable)
	{
		response.body = {
			result: "cannot determine",
			variablesReference: 0
		};
		debugSession.sendResponse(response);
		return;
	}


	let dapVariable = convertVariableToDAP(variable);
	let result = dapVariable.value.toString();
	if(dapVariable.type === "string")
	{
		result = "\""+result+"\"";
	}
	response.body = {
		result: dapVariable.value.toString(),
		type: dapVariable.type,
		variablesReference: dapVariable.variablesReference,
		namedVariables: dapVariable.namedVariables,
		indexedVariables: dapVariable.indexedVariables,
		presentationHint: dapVariable.presentationHint
	};
	debugSession.sendResponse(response);

}

export function registerEvaluateFunctions(context: vscode.ExtensionContext)
{
	// override the default debug hover with our one.
	// only squirrel is supported here!!!
	// This approach is not the pretties and not the most fool proof, a good one would be to use a proper tokenizer, however this serves quite well already.
	context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('squirrel', {
 		provideEvaluatableExpression(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.EvaluatableExpression> {
			//const VARIABLE_REGEXP: RegExp = /(\w+)/ig; // match regular words
			//const FULL_PATH_REGEXP: RegExp = /(?:^|\.|\[)([^.\[\]]+)/g;
			const line = document.lineAt(position.line).text;

			// ignore stuff that's between quotes and in comments.
			// very simple approach, it won't work for multiline strings and comments.
			if(/\s/.test(line.charAt(position.character)))
			{
				return undefined;
			}
			let isInQuote = false;
			let isVerbatim = false;
			let isInComment = false;
			for(let pos=0; pos<position.character+1; pos++)
			{
				// check for comments
				if(isInComment)
				{
					if(line.charAt(pos)==="*" && line.charAt(pos+1)==="/")
					{
						isInComment = false;
					}
				}
				else
				{
					if(line.charAt(pos)==="/")
					{
						if(line.charAt(pos+1)==="/") // rest of line is commented, don't continue
						{
							isInComment = true;
							break;
						}
						else if(line.charAt(pos+1)==="*")
						{
							isInComment = true;
						}
					}
				}

				// check how many quotes we have before our range;
				if(!isInComment && line.charAt(pos)==="\"")
				{
					// check if it's a verbatim string. If it is we ignore escape character.
					if(!isInQuote)
					{
						if(pos > 0 && line.charAt(pos-1)==="@")
						{
							isVerbatim = true;
						}
						isInQuote = true;
					}
					else
					{
						// if string is verbatim and there's another quote after that then we skip it, the string continues.
						if(isVerbatim)
						{
							if(line.charAt(pos+1)==="\"")
							{
								pos=pos+1;
							}
						}
						else
						{
							if( !((pos > 0) && (line.charAt(pos-1)==="\\" && line.charAt(pos-2)!=="\\" )) ) // if there's NOT an escape character before the quote and the backslash isn't escaped.
							{
								isInQuote = false;
								isVerbatim = false;
							}
						}
					}
				}
			}
			if(isInComment || isInQuote)
			{
				return undefined;
			}
			let currentChar = line.charAt(position.character);
			//const NAME_REGEX = /[A-Za-z0-9]*/; // match variable names
			const NAME_SEARCH_REGEX = /[A-Za-z0-9_]+/g;
			const SEPARATOR_REGEX = /^[.\[\]]+$/; // match literal dot . and square brackets []
			// go to the end of the word.
			let currentCharIdx = position.character;

			let lastCharacterIdx = position.character;
			let firstCharacterIdx = position.character;
			while(currentChar.match(/[A-Za-z0-9_]/i)!==null)
			{
				currentChar = line.charAt(currentCharIdx);
				currentCharIdx++;
			}
			lastCharacterIdx = currentCharIdx;

			let arrayCount = 0;
			isInQuote = false; // we know initally since we checked it up before.
			let bracketCount = 0;
			let firstVariableIsGlobal = false;
			for(let charIdx = position.character; charIdx >= 0; charIdx--)
			{
				// TODO this approach will break if the string used is verbatim!
				currentChar = line.charAt(charIdx);
				if(currentChar === "\"")
				{
					if(line.charAt(currentCharIdx-1)!=="\\")
					{
						isInQuote = !isInQuote;
					}
				}
				if(currentChar === "]")
				{
					arrayCount++;
				}
				else if(currentChar === "[")
				{
					arrayCount--;
				}
				else if(currentChar === ")")
				{
					bracketCount++;
					continue;
				}
				else if(currentChar==="(")
				{
					bracketCount--;
					continue;
				}

				if(arrayCount<=0 && !isInQuote && bracketCount<=0) // we can have lots of different things inside the accessor unlike the outside of it.
				{
					// not a regular character or separator, likely whitespace or something else.
					if(!(/^[a-zA-z0-9_]+$/.test(currentChar)))
					{
						if(!SEPARATOR_REGEX.test(currentChar))
						{
							firstCharacterIdx = charIdx;
							if(charIdx > 0 && currentChar===":" && line.charAt(charIdx-1)===":")
							{
								firstVariableIsGlobal = true;
								firstCharacterIdx--;
							}
							break;
						}
					}
					else
					{
						if(charIdx < position.character && line.charAt(charIdx+1)==="(")
						{
							break;
						}
					}
				}
				firstCharacterIdx = charIdx;
			}
			let variableNames: Array<string> = []; //we will use this to assemble a path to the variable.
			let varRange = new vscode.Range(position.line, firstCharacterIdx, position.line, lastCharacterIdx);
			let m: RegExpExecArray | null;
			while(m = NAME_SEARCH_REGEX.exec(line))
			{
				let pos = new vscode.Position(position.line, NAME_SEARCH_REGEX.lastIndex);
				if(varRange.contains(pos))
				{
					// TODO FIXME: we might get gibberish in case we grab stuff inside array accessor as they can be full expression and we only grab separate words
					variableNames.push(m[0]);
				}
			}
			let expression = variableNames.join(".");
			if(firstVariableIsGlobal)
			{
				expression = ":"+expression;
			}
			if(squirrelReservedKeywords.includes(expression)) {return undefined;}

			return new vscode.EvaluatableExpression(varRange, expression); // join all names with dots
		}
	}));

	// overwrite the default inline values functionality
	// this is unfinished and may be removed in the future.
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

						// value found via variable lookup
						allValues.push(new vscode.InlineValueVariableLookup(varRange, varName, false));

						// value determined via expression evaluation
						allValues.push(new vscode.InlineValueEvaluatableExpression(varRange, varName));
					}
				} while (m);
			}

			return allValues;
		}

	}));
}