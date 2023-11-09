// used to test call stacks with variables and hover contexts.
::var_global <- "Hello I'm global!"
::var_override <- "Hello I will be shadowed in a function!"
var_closure <- "Hello I'm a variable in this closure!"

function func1()
{
	local var_func1 = "Hello I'm func1!"
	local numFunc = 1;
	local context = this;
	local var_override = "I'm the shadow of my master!"
	func2();
}

function func2()
{
	local var_func2 = "Hello I'm func2!"
	local numFunc = 2;
	local context = this;
}