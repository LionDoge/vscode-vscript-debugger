'use strict';

// currently these functions are unused while the entity data functionality is being restored.

import { DebuggerVariable, DebuggerWatch } from "./customInterfaces";
import { VScriptDebugSession } from "./vscriptDebug";
import { pushToMapArray } from "./utilities";
import { addWatch, removeWatch } from "./watches";

/**
 * 
 * @param this the debugging session
 * @param watchesArray array of watches that the variables should be generated from
 * @param variable  the parent variable for which to generate the variables
 */
export function createVariablesFromWatches(this: VScriptDebugSession, watchesArray: DebuggerWatch[], variable: DebuggerVariable): void
{
	let holderVariable = variable;

	if(this.usedVariableReferencesEnt.includes(variable.variableReference)) {return;} // don't add stuff twice to the same entity.

	if(holderVariable)
	{
		this.usedVariableReferencesEnt.push(variable.variableReference);
		for(let watch of watchesArray)
		{
			let dataVariable = new DebuggerVariable(watch.displayName, watch.values[this.currentFrameID], watch.type);
			dataVariable.variableReference = watch.variableReference;
			dataVariable.ownerReference = holderVariable.variableReference;
			dataVariable.presentationHint = {
				kind: 'virtual'
			};
			pushToMapArray<number, DebuggerVariable>(this.localVariables, holderVariable.variableReference, dataVariable);
		}
	}
	else
	{
		for(let watch of watchesArray)
		{
			removeWatch(this, watch.id, false);
		}
		this.entityDataWatches.delete(variable.variableReference);
	}
}

// Add watches to get data from CBaseEntities
/**
 * 
 * @param this the debugging session
 * @param variable the variable which entity data watches should be generated for
 * @returns all new added variables
 */
export function setupEntityData(this: VScriptDebugSession, variable: DebuggerVariable): DebuggerVariable[]
{
	let newElements: Array<DebuggerVariable> = [];
	for(let childVariable of this.localVariables.get(variable.variableReference)!)
	{
		//if(childVariable.childReference === variable.variableReference)
		//{
			if(childVariable.type !== 'native function') {continue;}

			// look for available functions and add watches if we can.
			let isSupportedFunction = false;
			let isEntity = false;
			let displayName = "";
			switch (childVariable.name) {
				case "entindex":
					isSupportedFunction = true;
					isEntity = true;
					displayName = "entindex";
					break;
				case "GetClassname": // classname:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "classname";
					break;
				case "GetName": // targetname:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "targetname";
					break;
				case "GetHealth": // health
					isSupportedFunction = true;
					isEntity = true;
					displayName = "health";
					break;
				case "GetOrigin": // origin:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "origin";
					break;
				case "GetVelocity": // velocity: (//TODO also add speed to watches?)
					isSupportedFunction = true;
					isEntity = true;
					displayName = "velocity";
					break;
				case "GetTeam": // team:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "team";
					break;
				case "GetModelName": // modelname:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "modelname";
					break;
				case "GetScriptScope": // <SCRIPT SCOPE>:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "SCRIPT SCOPE";
					break;
				case "GetOwner:": // owner:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "owner";
					break;
				case "GetRootMoveParent": // parent:
					isSupportedFunction = true;
					isEntity = true;
					displayName = "parent";
					break;
			}

			if(isEntity)
			{
				variable.value = "Entity handle";
			}

			if(!isSupportedFunction) {continue;}
			// if the function is supported we can add a watch with it.

			addWatch(this, this.entityDataWatchID, variable.variablePath+'.'+childVariable.name+'()', displayName, variable.variableReference);

			// add variables even when not available
			let tempVariable = new DebuggerVariable(displayName, "available on next step", "data");
			tempVariable.ownerReference = variable.variableReference;
			tempVariable.presentationHint = {
				kind: 'virtual'
			};
			newElements.push(tempVariable);
			pushToMapArray<number, DebuggerVariable>(this.localVariables, tempVariable.variableReference, tempVariable);
		//}
	}
	return newElements;
}