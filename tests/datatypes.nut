function coro()
{
	printl("I will be a coroutine");
	::suspend();
	printl("I was a coroutine");
}

function gen()
{
	printl("I will be a generator");
	yield;
	printl("I was a generator");
}

{
	local str = "abCdE\tęść❤";
	local integ = 2;
	local flo = 3.141;
	local bool = true;
	local arr = ["abc", integ, flo];
	local arrNest = ["dEF123", arr];

	local tab = {
		a = "one",
		b = flo
	}
	tab[arr] <- str; // complex data type as table key.
	tab[3] <- arrNest;

	local funct = function(a,b) {return a+b};
	local generatorFunc = gen();
	local coroFunc = ::newthread(coro);
	local reference = tab.weakref();
	local ent = Entities.First(); // worldspawn

	local aClass = class {
		_member1 = "empty1";
		_member2 = "empty2";
		constructor()
		{
			_member1 = "Hello";
			_member2 = "World!";
		}
		function method1()
		{
			_member1 = _member1 + _member2;
		}
		function method2()
		{
			printl("member1: "+_member1);
			printl("member2: "+_member2);
		}
	}
	local classInstance = aClass();
}