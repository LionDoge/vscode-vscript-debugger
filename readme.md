# VScript Debugger

A debugger client extension using the Debug Adapter Protocol that allows debugging of VScripts in Source Engine games.
This extension uses native debugging features present in Source games and thus doesn't require any third party tools to be loaded into the game itself, meaning that it is safe from VAC.

Get it on the marketplace https://marketplace.visualstudio.com/items?itemName=LionDoge.vscript-debug
<br/>

## Disclaimer
This extension is still not stable, you might encounter some issues while using it, feel free to post them to the issue tracker if your issue isn't already there.
<br/>

## ✅ Supported and tested games
Feel free to contribute to the list. If you can attach the debugger and execute a basic script then it is already a good candidate.

"Older script engine" means that the debug server might be lacking some features or may be more prone to odd behaviors. Games utilizing older Squirrel versions clearly have their debugging server not finished.

- ![image](https://developer.valvesoftware.com/w/images/thumb/8/84/Tf2-16px.png/16px-Tf2-16px.png) **Team Fortress 2** | *Squirrel 3*
- ![image](https://developer.valvesoftware.com/w/images/thumb/8/8b/Icon-L4D2.png/16px-Icon-L4D2.png) **Left 4 Dead 2** | *Squirrel 3*
- ![image](https://developer.valvesoftware.com/w/images/0/06/Csgo-16px.png) **Counter-Strike: Global Offensive (Source 1)** | *(Older script engine)* | *Squirrel 2*
- ![image](https://developer.valvesoftware.com/w/images/thumb/3/3c/Portal2_icon.png/16px-Portal2_icon.png) **Portal 2** | *(Older script engine)* | *Squirrel 2*
- Mods based on these games may be supported.
## ❌ Confirmed unsupported games
- ![image](https://developer.valvesoftware.com/w/images/thumb/5/5b/Mapbase-16px.png/16px-Mapbase-16px.png) **Mapbase** | *Uses custom implementation without debugging features*
- ![image](https://developer.valvesoftware.com/w/images/thumb/9/95/Jbep3-16px.png/16px-Jbep3-16px.png) **Jabroni Brawl: Episode 3** | *Possibly implemented debugger but impossible to use*

## Source 2
Right now there are no plans to support games running on Source 2 engine as the debugger implementation differs vastly.
However it is possible to use different tools for debugging when using Lua:
https://developer.valvesoftware.com/wiki/Dota_2_Workshop_Tools/Scripting/Debugging_Lua_scripts

## Supported features
- Breakpoints
- Stepping over and stepping in/out
- Breaking on exceptions and displaying errors.
- Displaying the call stack
- Displaying local variables optionally along with the current root table
- Variable hover
- Watches
- Remote debugging (file access and game connection)
- **[CURRENTLY DISABLED]** Gathering data of entities (e.g. classname, health, model...) and it's script scope

## Basic usage example
1. Launch your game as normal. Windowed or windowed fullscreen is recommended as issues might occur on regular fullscreen when trying to switch out of the game during debugging.
2. ***(Not rquired for Squirrel 3 based script engines)*** Set `developer 1` in console (![image](https://developer.valvesoftware.com/w/images/0/06/Csgo-16px.png)CS:GO requires you to have `sv_max_allowed_developer` set higher than 0). **WARNING** For Squirrel 2 you need to do this step before loading a map, otherwise the debugger server won't behave correctly.
3. Load a map and depending on the script engine version execute the following command in console.
	- Older script engines (Squirrel v2.x or similar, i.e. ![image](https://developer.valvesoftware.com/w/images/thumb/3/3c/Portal2_icon.png/16px-Portal2_icon.png) **Portal 2**, ![image](https://developer.valvesoftware.com/w/images/0/06/Csgo-16px.png)**CS:GO** ...) type `script_debug`.
	- Newer script engines (Squirrel v3.x or similar, i.e. ![image](https://developer.valvesoftware.com/w/images/thumb/8/8b/Icon-L4D2.png/16px-Icon-L4D2.png) **L4D2**, ![image](https://developer.valvesoftware.com/w/images/thumb/8/84/Tf2-16px.png/16px-Tf2-16px.png) **Team Fortress 2**...) type `script_attach_debugger`.
4. Open a workspace in Visual Studio Code and load VScripts directory for the current game (by default `[game]/scripts/vscripts`).
	- If you don't want to open a workspace that's inside a script directory you will need to specify which directories you want to search in by adding `additionalScriptDirectories` to [launch.json](#launchjson-configuration) this is also useful if some of your scripts lie in different directories and you want to include them all for debugging.
5. Press F5 to attach the debugger to the game. (Make sure to use VScript launch configuration).

You are now able to add breakpoints as you wish. When hitting a breakpoint, or during an exception the game will freeze allowing you to step through code.

## launch.json configuration
To create this file, go to the debugging tab in the sidebar and click 'create a launch.json file'

Currently these launch.json configuration options exist:
- `ip` (string) the IP to connect the debugger to. If not specified the global configuration will be used
- `engineVersion` (enum) the script debugger engine version of the game being debugged. Either squirrel3 or squirrel2 (defaults to squirrel2) This serves a hint to the extension on which feature sets are available.
- `additionalScriptDirectories` (string array) Additional script directories to search in including the currently open workspace. Either relative path to currently open workspace or absolute path

## Why there are no variables in 'Closure' sometimes?
This is because the execution context is the root table, in order to see the closure of this context you need to turn on "display root table" in extension settings.
However note that it will likely slow down the debugger as the game needs to send way more information.

## Known issues and notes
**Applies to every tested game except ![image](https://developer.valvesoftware.com/w/images/thumb/8/8b/Icon-L4D2.png/16px-Icon-L4D2.png) L4D2**
- Files with the same names, even in different directories can't be distinguished. This is an issue present in the debug server itself. The extension tries its best to deduce the file, if it can't do that the user will be prompted to choose one. This might cause problems when working with different files of same file names in one session.

**Applies to every Squirrel2 games (most notably: ![image](https://developer.valvesoftware.com/w/images/thumb/3/3c/Portal2_icon.png/16px-Portal2_icon.png) and ![image](https://developer.valvesoftware.com/w/images/0/06/Csgo-16px.png))**
- Developer messages will be printed to the game console while debugging. To avoid this you can switch back to `developer 0` **AFTER** attaching the debugger.
- Sometimes problems with stepping can occur when a class instance is using custom _get and _set metamethods.
- When execution is finished after using a step (not resume) button the game will resume but not catch any breakpoints. Current workaround is to detect when no information is sent and resume after specified time. However it means that during this time period breakpoints won't work.
- While adding watches they won't be evaluated immediately, one debugger step is required to do so. Unfortunately that's a limitation in the implementation of the debugging server. (Squirrel 3 games support updating in place.)
- Setting a breakpoint on an empty line or something that isn't an expression e.g. line that contains only a bracket, the server won't stop on that line, nor correct it. Make sure to put breakpoints on lines that contain expressions, definitions, statement heads, etc.

**General information for all games**
- Doesn't function on Linux, while the extension could support it, the game doesn't - attempting to even just run commands for script debugging will cause the game to crash.
- The game sometimes can disconnect the debugger right after the connecting, putting the game in a state where it won't execute code. To fix simply reattach the debugger again.
- When unchecking the 'All exceptions' breakpoint execution will be resumed automatically right after the game encounters an error. It doesn't disable it in game itself, which means that data has to arrive before resuming, this could possibly cause small stutters while the debugger skips an error.
- Sending data is pretty slow due to the way it is implemented in game. This is noticable when enabling the root table display.
