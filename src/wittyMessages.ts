// mostly tf2 quotes
var wittyMessages = [
	"Godspeed, you magnificent bastard.",
	"Sorry to 'pop-in' unannounced.",
	"Well, off to visit your mother!",
	"You are an amateur and a fool!",
	"I appear to have burst into flames.",
	"What is your major malfunction, brother?",
	"Nice hustle, 'tons-a-fun'! Next time, eat a salad!",
	"Here's a schematic for ya: my ass!",
	"Diagnosis: you suck!",
	"You camped the whole time for this?!",
	"Remember me? Yeah, ya do!",
	"Who's the tough guy now, huh, tough guy?",
	"Murr hurr mphuphurrur, hurr mph phrr.",
	"I told ya don't touch that darn thing.",
	"Boy, this here is just gonna keep happenin' and happenin'.",
	"I've seen better sides of beef been run over by a combine."
];

export function getRandomWittyComment()
{
	return wittyMessages[Math.floor(Math.random()*wittyMessages.length)];
}