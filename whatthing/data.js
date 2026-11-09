// WHAT THING ARE YOU — questions and things.
// Each question moves one of four axes. Each thing sits somewhere on those axes:
//   M  mystic (+1) ... rational (-1)
//   O  ornate (+1) ... plain (-1)
//   H  heavy  (+1) ... light (-1)
//   F  many   (+1) ... one   (-1)
// A thing is [name, M, O, H, F, one-line blurb, optional longer paragraph].
// Your thing in each category is the one nearest your answers.

const WT = {};

WT.axes = [
  {k:'M', pos:'Mystic',  neg:'Rational'},
  {k:'O', pos:'Ornate',  neg:'Plain'},
  {k:'H', pos:'Heavy',   neg:'Light'},
  {k:'F', pos:'Many',    neg:'One'}
];

// ax: which axis; s: what the LEFT answer adds to it (the right answer adds -s)
WT.questions = [
  {a:"Platonic", ad:"The real thing is the Form. This world is a draft.",
   b:"Aristotelian", bd:"The real thing is right here. Go measure it.",
   hint:"Where does truth live?", ax:'M', s:1},
  {a:"Pascalian", ad:"The heart has reasons reason knows nothing of.",
   b:"Cartesian", bd:"Doubt everything, then rebuild from the ground up.",
   hint:"How do you know anything?", ax:'M', s:1},
  {a:"Gay", ad:"Arch, knowing, a little theatrical. Life as a well-lit room.",
   b:"Straight", bd:"Earnest, sturdy, unbothered. Life as a hardware store.",
   hint:"In the sensibility sense, not the census sense.", ax:'O', s:1},
  {a:"Jewish", ad:"Rye bread, argument as love language, a good worry.",
   b:"Goyish", bd:"White bread, polite silence, the lake house.",
   hint:"Per the old taxonomy: things, not people.", ax:'H', s:1},
  {a:"Ashkenazi", ad:"Brisket, cold winters, a cello in the corner.",
   b:"Sephardi", bd:"Saffron, sea air, an oud on the terrace.",
   hint:"Which table would you rather sit at?", ax:'O', s:-1},
  {a:"Indica", ad:"Into the couch. Heavy blanket, long exhale.",
   b:"Sativa", bd:"Off the couch. Ideas, errands, a sudden walk.",
   hint:"Pick a direction.", ax:'H', s:1},
  {a:"Da Vinci", ad:"Notebooks full of half-finished flying machines.",
   b:"Michelangelo", bd:"One block of marble, hammered until it's David.",
   hint:"How do you make things?", ax:'F', s:1},
  {a:"Apollonian", ad:"Order, proportion, the clean white column.",
   b:"Dionysian", bd:"Wine, music, the column knocked over at 2 a.m.",
   hint:"Nietzsche wants to know.", ax:'O', s:-1},
  {a:"Hedgehog", ad:"Knows one big thing, and knows it completely.",
   b:"Fox", bd:"Knows many small things, and trusts none of them fully.",
   hint:"After Archilochus, by way of Isaiah Berlin.", ax:'F', s:-1},
  {a:"Tolstoy", ad:"Wheat fields, big families, history as a river.",
   b:"Dostoevsky", bd:"A small room, a fever, a conversation with God.",
   hint:"Pick your Russian.", ax:'H', s:-1},
  {a:"Athens", ad:"The academy. Reason, inquiry, the open question.",
   b:"Jerusalem", bd:"The temple. Revelation, covenant, the answer given.",
   hint:"As Tertullian asked: what has one to do with the other?", ax:'M', s:-1},
  {a:"Lumper", ad:"These are all basically the same thing.",
   b:"Splitter", bd:"Actually, these are four different things.",
   hint:"How do you sort the world?", ax:'F', s:-1}
];

WT.categories = [
{id:'yogurt', name:'Yogurt', as:'a yogurt', color:'#c8553d', items:[
  ["Fage Total",-1,-0.33,-0.33,-1,"Classical, full-fat, unapologetic.","You are the column at the front of the building. Thick, plain, and deeply sure of yourself, you believe the good life was mostly figured out a few thousand years ago and that the rest is garnish."],
  ["Siggi's",-0.33,-0.67,0.33,0.33,"Austere, high-protein, faintly melancholy.","You are a northern mind in a downtown apartment. You like rules, short ingredient lists, and the particular pleasure of a sentence with nothing extra in it."],
  ["Chobani",-0.33,-0.33,-0.33,-1,"Wholesome, ambitious, sincerely optimistic.","You are the good neighbor of the dairy case. Hardworking, warm, and allergic to cynicism, you believe things get better when people show up and do the work."],
  ["Noosa",-0.33,1,-0.33,-0.33,"Honeyed, indulgent, a little too much (in a good way).","You are dessert pretending to be breakfast. Rich, generous, and slightly theatrical, you believe pleasure is a perfectly respectable organizing principle."],
  ["Yoplait",-1,-0.33,-1,0.33,"Sunny, practical, quietly French.","You are cheerful efficiency with a hidden Cartesian streak. Approachable, unfussy, a little bit of everything, you'd rather be liked than admired and you're right to."],
  ["Activia",1,-1,1,0.33,"Faith-based digestion. The gut has reasons.","You are a believer. You take the long view, the inner view, the view from inside the intestinal tract. Somewhere in you is a small worry that has been lovingly tended for decades."],
  ["Stonyfield",1,0.33,-0.33,0.33,"Organic, pastoral, earnestly good.","You are a farm in New England with a mission statement. You care where things come from, who made them, and whether the cows had a nice day."],
  ["Liberté",-0.33,1,0.33,1,"Continental, sly, mildly existential.","You are a café table with an ashtray and a notebook. Clever, a bit cool, and constantly splitting hairs that other people didn't know were two hairs."],
  ["White Mountain Bulgarian",1,-0.33,1,-1,"Sour, ancient, devoted.","You are an old-world grandmother with a jar on the windowsill. Tangy, uncompromising, and in possession of secrets you will share only with the worthy."],
  ["Lifeway Kefir",1,0.33,1,0.67,"Drinkable, fermented, from the old country.","You are the brooding cousin who shows up with a bottle and a theory. Restless, effervescent, half-Russian novel, half-science experiment."],
  ["Ellenos",0.33,1,0.67,0.33,"Lush, ornamental, devastatingly rich.","You are a baroque ceiling in yogurt form. Decadent, a little extra, and absolutely not sorry about it. You believe in the transcendent power of texture."],
  ["Dannon Plain",-0.33,-1,-0.33,-1,"Foundational, reliable, the control group.","You are the baseline against which all others are measured. Unadorned, dependable, a little old-fashioned in the best possible way."],
  ["Go-Gurt",-0.33,1,-0.67,0.33,"Squeezable, kinetic, unbothered by tradition.","You are pure forward motion. Who needs a spoon? Who needs a bowl? You invent your own containers and leave the old ones behind."],
  ["Lavva",0.33,1,-0.67,1,"Plant-based, tropical, gently utopian.","You are a sunlit idea about how things could be. Coconut, plantain, a conviction that the old categories were never quite right."]
]},
{id:'coffee', name:'Coffee brand', as:'a coffee brand', color:'#6b4a35', items:[
  ["Folgers",-0.5,-1,0,-1,"Red can, no notes, up at five."],
  ["Starbucks",-0.5,0.5,-0.5,1,"A thousand options and your name spelled wrong on the cup."],
  ["Dunkin'",-1,-0.5,-1,-0.5,"Iced, regular, in January. Unbothered."],
  ["Café Bustelo",0,0.5,0.5,-1,"Small brick, big voltage, abuela-approved."],
  ["Lavazza",-0.5,0.5,-0.5,-0.5,"Italian, elegant, frankly a little vain about it."],
  ["Illy",-1,0,-1,-1,"Silver tin, perfect proportions, Apollonian to the bean."],
  ["Peet's",0,-0.5,1,-1,"Dark roast, Berkeley, no apologies."],
  ["Stumptown",0.5,0.5,0,1,"Cold brew in a stubby bottle. Tattoos optional."],
  ["Blue Bottle",1,0,-0.5,-1,"Pour-over as spiritual practice. Twelve minutes per cup."],
  ["Maxwell House",-1,-1,0.5,-0.5,"Grandpa's percolator in a church basement."],
  ["Nescafé",-1,-0.5,0,1,"Instant, global, slightly desperate."],
  ["La Colombe",0.5,1,0,0.5,"Draft latte, foamed, a bit theatrical."],
  ["Death Wish",0,0.5,1,0,"A skull on the bag and a heart rate to match."],
  ["Chock full o'Nuts",-1,-0.5,0.5,-1,"Old New York at a diner counter."]
]},
{id:'fluoride', name:'Fluoride flavor', as:'a fluoride flavor', color:'#3f9ea0', items:[
  ["Mint",-1,-1,0,-1,"The only adult in the waiting room."],
  ["Bubblegum",-0.5,1,-1,0.5,"Pink, loud, sticks to everything."],
  ["Cherry",0,0.5,0,-0.5,"Classic, slightly medicinal, secretly beloved."],
  ["Grape",0.5,0.5,0.5,0,"Purple in a way no grape has ever been."],
  ["Strawberry",0,0,-1,-0.5,"Sweet, uncomplicated, nobody's enemy."],
  ["Watermelon",-0.5,0,-1,1,"Summer in a tray. Mostly water, entirely fun."],
  ["Piña Colada",0,1,-0.5,1,"On vacation, even in the chair."],
  ["Cotton Candy",1,1,-1,0.5,"Pure dream. Dissolves on contact."],
  ["Unflavored",-1,-1,1,-1,"You came here for fluoride, not for a good time."],
  ["Root Beer",0.5,0,1,-0.5,"Dark, foamy, nostalgic for a soda fountain you never saw."],
  ["Mango",0.5,0.5,-0.5,0,"Tropical, golden, a little bit far away."],
  ["Caramel",0,0.5,1,-1,"Rich and slow. Coats every surface."],
  ["Orange",-1,0,-1,0,"Bright, practical, vitamin-adjacent."]
]},
{id:'insurance', name:'Insurance company', as:'an insurance company', color:'#2f5d8a', items:[
  ["State Farm",-0.5,-1,-0.5,-1,"A neighbor with a clipboard and a firm handshake."],
  ["Allstate",-1,-1,0.5,-1,"A deep, reassuring voice explaining what could go wrong."],
  ["Geico",0,1,-1,0.5,"Fifteen minutes, a joke, and you're done."],
  ["Progressive",-1,0,-1,1,"Comparison shopping as a way of life."],
  ["Liberty Mutual",0,0,-0.5,1,"Customizes everything and hums while doing it."],
  ["Nationwide",-0.5,-0.5,0,0,"Steady, Midwestern, present at every county fair."],
  ["USAA",-1,-1,0,-1,"Disciplined, loyal, eats breakfast at 0600."],
  ["Farmers",-0.5,-0.5,0.5,1,"Has seen every bizarre claim and remembers them all."],
  ["Aflac",0.5,1,-0.5,-1,"One loud idea, repeated with total conviction."],
  ["MetLife",0,-0.5,1,-0.5,"Thinks about the long term. The very long term."],
  ["Lloyd's of London",0.5,1,1,1,"Will insure a pianist's hands or a ship in a storm. Has a bell."],
  ["Chubb",-1,0,1,-1,"Old houses, old money, a quiet assessor in loafers."],
  ["Travelers",0.5,0,0,1,"Under the red umbrella, already halfway somewhere else."],
  ["Lemonade",1,0.5,-1,0.5,"Run on an app and a theory of human goodness."]
]},
{id:'roofing', name:'Roofing material', as:'a roofing material', color:'#7a5c3e', items:[
  ["Asphalt shingle",-1,-1,0,-1,"The default. It works. Nobody writes poems about it."],
  ["Slate",-0.5,0,1,-1,"Lasts a century, weighs a ton, broods in the rain."],
  ["Terracotta tile",0,1,-1,-0.5,"Sun-baked, Mediterranean, curving like a smile."],
  ["Thatch",1,0.5,0.5,1,"Ancient, shaggy, home to a small ecosystem."],
  ["Standing-seam metal",-1,-0.5,-1,-1,"Clean lines, sheds everything, sounds amazing in a storm."],
  ["Cedar shake",0.5,0,0,0.5,"Weathers to silver and doesn't mind getting older."],
  ["Green roof",1,0.5,0,1,"Grows things. Has ideals."],
  ["Copper",0.5,1,0.5,-1,"Starts bright, ends green, majestic the whole way."],
  ["Corrugated tin",-1,-0.5,-0.5,1,"Cheap, loud, endlessly adaptable."],
  ["Solar tiles",-0.5,-0.5,-1,1,"Believes in the future and is invoicing it."],
  ["Rubber membrane",-1,-1,1,-1,"Flat, black, and frankly depressed."],
  ["Gold-leaf dome",1,1,0.5,-1,"Faith, made visible from twenty miles away."]
]},
{id:'edm', name:'EDM subgenre', as:'an EDM subgenre', color:'#6a3fa0', items:[
  ["Techno",-0.5,-1,1,-1,"Four on the floor in a concrete room until sunrise."],
  ["House",-0.5,0.5,-1,0,"A gospel organ, a warm kick, everybody's welcome."],
  ["Trance",1,0.5,-0.5,-1,"Hands up, eyes closed, ascending."],
  ["Drum and bass",-0.5,0,0.5,1,"174 BPM and an argument about the bassline."],
  ["Dubstep",-1,1,1,0.5,"The drop. Then the drop again."],
  ["Ambient",1,-1,0,-1,"Music for airports and the inside of your eyelids."],
  ["Nu-disco",-0.5,1,-1,0.5,"Mirror balls and string sections, no regrets."],
  ["IDM",-1,0,0.5,1,"Glitches arranged by someone with a spreadsheet."],
  ["Hardstyle",-1,1,0,-1,"The kick drum as moral philosophy."],
  ["Deep house",0,0,0.5,-0.5,"Late, warm, a little sad in a good way."],
  ["Psytrance",1,1,0,1,"A forest at dawn and a cosmology to explain it."],
  ["Downtempo",0.5,0,1,0,"Slow, smoky, a lounge at 4 a.m."],
  ["UK garage",0,0.5,-0.5,1,"Skippy beats, sharp shoes, Sunday afternoon."]
]},
{id:'typeface', name:'Typeface', as:'a typeface', color:'#2a2420', items:[
  ["Helvetica",-1,-1,-0.5,-1,"Neutral to the point of doctrine."],
  ["Garamond",0,0,0,-0.5,"Literate, unhurried, smells like a library."],
  ["Comic Sans",0,1,-1,1,"Earnest, sunny, and tired of being judged."],
  ["Futura",-1,0,-1,-1,"Geometry with ambition. Went to the moon."],
  ["Times New Roman",-0.5,-0.5,0.5,0,"Did its homework. Double-spaced."],
  ["Papyrus",1,1,0,0.5,"Mystical, in a gift-shop sort of way."],
  ["Fraktur",1,0.5,1,-1,"A Gothic cathedral in 12-point."],
  ["Courier",-1,-1,0.5,1,"Typewriter clack. Unedited thoughts."],
  ["Bodoni",0,1,0.5,-1,"High contrast, high fashion, high cheekbones."],
  ["Gill Sans",-0.5,-0.5,0,0.5,"British, polite, slightly odd at dinner."],
  ["Caslon",0.5,0,0.5,-0.5,"Set the Declaration and has never let you forget it."],
  ["Cooper Black",0,1,-0.5,0,"Soft, round, warm. A hug from the seventies."],
  ["Optima",0.5,0,-0.5,0,"Classical and modern at once, a little dreamy."]
]},
{id:'houseplant', name:'Houseplant', as:'a houseplant', color:'#4f7d3a', items:[
  ["Snake plant",-1,-1,0,-1,"Thrives on neglect. Asks for nothing."],
  ["Monstera",0,1,-0.5,1,"Big leaves, bigger personality, takes over the room."],
  ["Fiddle-leaf fig",0.5,1,0.5,-1,"Gorgeous and dramatic. Will die if you move it six inches."],
  ["Pothos",-0.5,0,-1,1,"Grows anywhere, trails everywhere, friend to all."],
  ["Orchid",1,1,0.5,-1,"Exquisite, temperamental, blooms when it decides to."],
  ["Cactus",0,-0.5,-1,-1,"Prickly outside, sunny within, needs no one."],
  ["Bonsai",1,-0.5,0,-1,"Decades of patient discipline in one small pot."],
  ["Fern",0.5,0,1,1,"Ancient, damp, loves a dim corner."],
  ["Peace lily",1,-0.5,0.5,0,"Wilts theatrically, recovers instantly."],
  ["Venus flytrap",-1,0.5,1,-0.5,"Carnivorous and proud of it."],
  ["Air plant",1,0.5,-1,1,"Needs no soil. Barely needs you."],
  ["Rubber plant",-0.5,-0.5,0.5,0,"Glossy, sturdy, dependable as a filing cabinet."]
]},
{id:'cheese', name:'Cheese', as:'a cheese', color:'#d4a72c', items:[
  ["American",-1,-1,-1,-1,"Melts on command. Asks no questions."],
  ["Brie",0,1,0,0,"Soft, ripe, at its best a little too warm."],
  ["Parmigiano-Reggiano",-1,0,0.5,-1,"Aged two years, certified, unbending."],
  ["Roquefort",0.5,0.5,1,0.5,"Blue veins and a cave in the south of France."],
  ["Feta",-0.5,0,-1,0,"Salty, crumbly, sunny, good with everything."],
  ["Gouda",-0.5,-0.5,0,0,"Round, Dutch, cheerfully reasonable."],
  ["Limburger",0,0,1,1,"Pungent, misunderstood, beloved by the few."],
  ["Burrata",0.5,1,-0.5,-1,"A heart of cream in a fragile shell."],
  ["Cheddar",-1,-1,0,0.5,"Comes in every strength. Agrees with everyone."],
  ["Gruyère",0,0,0.5,-0.5,"Alpine, nutty, made for fondue and long winters."],
  ["Cottage cheese",-0.5,-1,0.5,1,"Lumpy, honest, makes no effort to impress."],
  ["Halloumi",-0.5,0.5,-1,1,"Squeaks, grills, holds its shape under pressure."],
  ["Époisses",1,1,1,0,"Washed in brandy. Smells like transcendence."]
]},
{id:'bread', name:'Bread', as:'a bread', color:'#b07a3a', items:[
  ["White sandwich loaf",-1,-1,-1,-1,"Soft, square, and never surprising."],
  ["Rye",0,-0.5,1,-0.5,"Seeded, sour, eaten with an argument."],
  ["Challah",0.5,0.5,0,-1,"Braided, glossy, shows up for the holy day."],
  ["Baguette",-1,0,-1,0,"Crisp, French, a little rude, gone by evening."],
  ["Sourdough",0.5,0,0,1,"Has a starter with a name and a backstory."],
  ["Pumpernickel",0.5,-0.5,1,-1,"Dense, dark, steamed all day in the forest."],
  ["Brioche",0,1,-0.5,0,"Butter, eggs, an air of aristocracy."],
  ["Pita",-0.5,0,-1,1,"Opens up, holds anything, travels well."],
  ["Focaccia",-0.5,1,-1,1,"Dimpled, oily, studded with whatever's around."],
  ["Matzo",1,-1,0.5,-1,"Unleavened. No time. Pure memory."],
  ["Bagel",-0.5,0,0.5,0,"Boiled, then baked. Complicated by design."],
  ["Croissant",0.5,1,0,1,"Eighty-one layers and a lot of feelings."]
]},
{id:'dog', name:'Dog breed', as:'a dog breed', color:'#a0603f', items:[
  ["Golden retriever",-0.5,0,-1,0.5,"Loves you, loves everyone, loves the ball."],
  ["Border collie",-1,-1,0,-1,"Needs a job. Has a plan. Is judging your plan."],
  ["Poodle",-0.5,1,-0.5,0.5,"Brilliant, elegant, groomed into an argument."],
  ["Basset hound",0,-0.5,1,-1,"Long ears, long face, long naps."],
  ["Dachshund",0,0.5,0,-1,"Small, stubborn, convinced of its own importance."],
  ["German shepherd",-1,-0.5,0.5,0,"Loyal, serious, does the right thing."],
  ["Afghan hound",1,1,0,-1,"Aloof, silken, faintly unearthly."],
  ["Labrador",-1,-1,-1,0,"Friendly, sturdy, eats anything."],
  ["Jack Russell",-0.5,0,-1,1,"Never stops. Never."],
  ["Saint Bernard",0.5,-0.5,1,-0.5,"Enormous heart, brandy barrel, slow rescue."],
  ["Pug",0.5,1,0.5,0,"Wheezes, snores, utterly theatrical."],
  ["Greyhound",0.5,0,0.5,1,"Built for speed, mostly lies on the couch dreaming."],
  ["Shiba inu",1,0,-0.5,-1,"Independent, fox-faced, and enlightened about it."],
  ["Bulldog",-1,0,1,-1,"Stocky, stubborn, unbudgeable."]
]},
{id:'cloud', name:'Cloud', as:'a cloud', color:'#5b7d9a', items:[
  ["Cumulus",-0.5,0,-1,0,"Puffy, friendly, a fair-weather sort."],
  ["Cirrus",1,0,-1,1,"Wisps at 30,000 feet, thinking about something else."],
  ["Cumulonimbus",0,1,1,-1,"Towering, electric, one enormous idea."],
  ["Stratus",-1,-1,0.5,-1,"Gray, even, total coverage. A Tuesday."],
  ["Nimbostratus",-0.5,-1,1,0,"Rain all day. No drama, no end."],
  ["Mammatus",1,1,1,1,"Strange pouches overhead, unsettling and beautiful."],
  ["Altocumulus",0.5,0.5,-0.5,1,"Ripples like fish scales. Changeable."],
  ["Lenticular",1,0.5,0,-1,"Looks like a flying saucer; holds perfectly still over a mountain."],
  ["Noctilucent",1,0,0,0,"Glows at night at the edge of space."],
  ["Fog",0.5,-1,1,1,"Ground-level, obscuring, comfortable not knowing."],
  ["Contrail",-1,-0.5,-1,1,"Made by machines, gone in a minute."]
]},
{id:'architecture', name:'Architectural style', as:'an architectural style', color:'#8a8178', items:[
  ["Brutalism",-1,-1,1,-1,"Raw concrete and moral seriousness."],
  ["Gothic",1,1,1,0,"Spires, gargoyles, light through colored glass."],
  ["Baroque",0.5,1,0,1,"Gold, curves, angels everywhere at once."],
  ["Bauhaus",-1,-1,-1,0,"Form follows function. Lunch follows meeting."],
  ["Greek Revival",-0.5,0,0,-1,"Columns on a bank. Reason on display."],
  ["Art Deco",-0.5,1,-1,0,"Chrome, zigzags, a cocktail at the top."],
  ["Craftsman",0,-0.5,0,0.5,"Wide porch, built-in shelves, honest woodwork."],
  ["Moorish",1,1,-0.5,1,"Tiles, arches, a fountain in the courtyard."],
  ["Shaker",1,-1,0,-1,"Simple gifts. A chair hung on a peg."],
  ["Victorian",0,1,1,1,"Turrets, gingerbread trim, one room nobody enters."],
  ["Mid-century modern",-1,0,-1,1,"Glass walls, a sunken living room, optimism."],
  ["Deconstructivism",-1,0.5,0.5,1,"Walls at angles nobody asked for."]
]},
{id:'pasta', name:'Pasta shape', as:'a pasta shape', color:'#d9822b', items:[
  ["Spaghetti",-1,-1,-1,-1,"The one everyone knows."],
  ["Farfalle",0,1,-1,0.5,"Bow ties at the picnic."],
  ["Rigatoni",-1,0,0.5,-1,"Sturdy, ridged, built to hold sauce."],
  ["Orecchiette",0.5,0,-0.5,0,"Little ears, pressed by thumb in Puglia."],
  ["Fusilli",0,0.5,-0.5,1,"Spirals. Catches everything."],
  ["Lasagna",-0.5,0,1,-1,"Layers on layers. Heavy. Worth it."],
  ["Tortellini",1,0.5,0.5,0,"Shaped like a navel, and there's a legend about it."],
  ["Orzo",-0.5,-1,0,1,"Pretends to be rice, and it works."],
  ["Pappardelle",0.5,1,0.5,-1,"Wide ribbons, wild boar ragù, a Tuscan evening."],
  ["Radiatori",-1,0.5,0,1,"Shaped like a radiator. Somebody's idea."],
  ["Angel hair",1,-0.5,-1,-1,"Delicate, ethereal, overcooked in a moment."],
  ["Gnocchi",0,-0.5,1,0,"Technically not pasta, and doesn't care."]
]},
{id:'car', name:'Car brand', as:'a car brand', color:'#3a3a3a', items:[
  ["Toyota",-1,-1,-1,-1,"It will outlive you."],
  ["Volvo",-1,-1,0.5,-1,"Safe, square, thinking about your safety."],
  ["Subaru",0,-0.5,-0.5,1,"Roof rack, dog in back, trailhead."],
  ["BMW",-1,0.5,0,-1,"Precision, speed, and a firm opinion about the left lane."],
  ["Volkswagen",0,0,-1,1,"Friendly, quirky, used to be a bus."],
  ["Jeep",-0.5,0,-1,0.5,"Doors off, mud on, map unfolded."],
  ["Mercedes-Benz",-0.5,0.5,0.5,-1,"Heavy doors, quiet cabin, a sense of having arrived."],
  ["Alfa Romeo",0.5,1,0,0,"Beautiful, passionate, in the shop."],
  ["Ferrari",0,1,-0.5,-1,"Red, loud, one purpose."],
  ["Rolls-Royce",0.5,1,1,-1,"Silent, enormous, a statue on the hood."],
  ["Citroën",1,0.5,0,1,"Hydropneumatic suspension and a philosophy."],
  ["Saab",0.5,-0.5,0.5,0.5,"Built by jet engineers. The ignition is between the seats."],
  ["Lada",-0.5,-1,1,0,"Fixable with a hammer under gray skies."]
]},
{id:'gemstone', name:'Gemstone', as:'a gemstone', color:'#2f7d6b', items:[
  ["Diamond",-1,0,-1,-1,"Hard, clear, a single brilliant point."],
  ["Pearl",0.5,0,0,-1,"Formed slowly around an irritation."],
  ["Opal",1,1,0,1,"Every color at once, shifting as you turn."],
  ["Onyx",0,-1,1,-1,"Black, polished, keeps its counsel."],
  ["Amethyst",1,0.5,0.5,0,"Purple. Said to prevent drunkenness."],
  ["Emerald",0,1,0,-0.5,"Lush green, slightly flawed, royal."],
  ["Ruby",-0.5,1,0.5,-1,"Blood-red and fully committed."],
  ["Turquoise",0.5,0,-1,0.5,"Sky-blue, desert-born, worn every day."],
  ["Garnet",-0.5,-0.5,1,0,"Deep red, unassuming, ancient."],
  ["Lapis lazuli",1,0.5,0.5,-1,"Gold flecks in midnight blue, ground up for painted saints' robes."],
  ["Quartz",-1,-1,0,1,"Everywhere, useful, keeps time."],
  ["Amber",1,0,1,1,"Fossil sunlight with a bug inside."],
  ["Jade",0.5,-0.5,-0.5,-1,"Cool, smooth, carved with patience."]
]},
{id:'instrument', name:'Instrument', as:'an instrument', color:'#8e3b5c', items:[
  ["Piano",-1,0,0,1,"Can play every part at once."],
  ["Cello",0.5,0,1,-1,"Deep, warm, like a human voice in mourning."],
  ["Violin",0.5,1,0,0,"Virtuosic, nervous, the lead."],
  ["Accordion",0,1,0.5,1,"Breathes, wheezes, plays every wedding."],
  ["Oboe",0,-0.5,0.5,-1,"Tunes the orchestra. Is right about it."],
  ["Trumpet",-1,0.5,-1,-1,"Loud, bright, announcing."],
  ["Harp",1,1,-0.5,0,"Angels, glissandi, a lot of tuning."],
  ["Bagpipes",0.5,0.5,1,-1,"One sound, at full volume, forever."],
  ["Triangle",-1,-1,-1,-1,"One note, perfectly placed."],
  ["Pipe organ",1,1,1,1,"Fills a cathedral. Uses its feet."],
  ["Banjo",-0.5,0,-1,1,"Bright, plucky, a porch at dusk."],
  ["Theremin",1,0.5,0,1,"Played without touching. Spooky."],
  ["Double bass",-0.5,-1,1,0,"Holds everything up, rarely thanked."]
]},
{id:'office', name:'Office supply', as:'an office supply', color:'#c99a3e', items:[
  ["Stapler",-1,-1,0,-1,"Joins things. Doesn't negotiate."],
  ["Paper clip",-1,-1,-1,0,"Flexible, reusable, endlessly repurposed."],
  ["Sticky note",-0.5,0.5,-1,1,"Little yellow bursts of thought, everywhere."],
  ["Fountain pen",1,0.5,0.5,-1,"Ink-stained, ceremonial, opinions about nibs."],
  ["Label maker",-1,0,-0.5,1,"Everything in its place, and the place has a name."],
  ["Highlighter",-0.5,1,-1,0,"Neon, decisive, marks what matters."],
  ["Binder clip",-1,-0.5,0.5,-1,"Holds enormous stacks with grim resolve."],
  ["Rolodex",0.5,-0.5,1,1,"Remembers everyone you've ever met."],
  ["Letter opener",0.5,1,0.5,-1,"A small dagger with a desk job."],
  ["Hole punch",-1,-1,1,0,"Makes holes. Keeps the confetti."],
  ["Correction fluid",0.5,0,0.5,0,"Believes in second chances."],
  ["Pencil sharpener",0,-1,0,-1,"Brings things to a point."]
]},
{id:'sparkling', name:'Sparkling water', as:'a sparkling water', color:'#4a8fb0', items:[
  ["Perrier",-0.5,0.5,-1,-1,"Green glass, French, sharp bubbles."],
  ["San Pellegrino",0,1,-0.5,0,"Red star, white tablecloth."],
  ["LaCroix",0,0.5,-1,1,"A whisper of fruit in a can like a vacation."],
  ["Topo Chico",-1,0,-0.5,-1,"Aggressive carbonation, cult following."],
  ["Polar",-1,-1,-1,1,"Massachusetts, cheap, every flavor imaginable."],
  ["Gerolsteiner",-1,-1,0.5,-1,"Mineral-heavy, German, good for you."],
  ["Badoit",0.5,0.5,0,0,"Fine bubbles, French, gentle."],
  ["Seltzer siphon",0.5,0,1,-0.5,"Delivered in heavy glass by a man who knows your grandmother."],
  ["Vichy Catalan",0,0,1,0.5,"Salty, volcanic, an acquired devotion."],
  ["Club soda",-1,-1,0,0,"Behind the bar, mixing quietly."],
  ["Spindrift",0.5,0,-1,0.5,"Real fruit, slightly cloudy, earnest."],
  ["Mountain Valley",1,0,0,-1,"Green bottle, Arkansas spring, a long lineage."]
]},
{id:'tree', name:'Tree', as:'a tree', color:'#3d6b4f', items:[
  ["Oak",-1,-1,0,-1,"Strong, slow, centuries of quiet authority."],
  ["Weeping willow",1,0.5,1,0,"Trailing branches, riverside sorrow."],
  ["Birch",0.5,-0.5,-0.5,0,"White bark, northern light, slender."],
  ["Redwood",1,0,0,-1,"Unthinkably old, unthinkably tall."],
  ["Cherry blossom",0.5,1,-1,0,"Glorious for a week, then confetti."],
  ["Palm",-0.5,0.5,-1,1,"Swaying, sunny, never in a hurry."],
  ["Baobab",0.5,0,1,0,"Swollen trunk full of water; the village meets under it."],
  ["Pine",-1,-1,0.5,0,"Evergreen, needled, smells like December."],
  ["Ginkgo",0,0.5,0,1,"A living fossil with fan-shaped leaves."],
  ["Maple",-0.5,0.5,-0.5,-1,"Turns red, gives syrup, very well-adjusted."],
  ["Olive",0.5,0,-0.5,-1,"Gnarled, Mediterranean, sacred, patient."],
  ["Banyan",1,1,0,1,"Drops roots from its branches and becomes a forest by itself."],
  ["Apple",-0.5,0,-0.5,1,"Fruitful, a little tempting, knows a lot."]
]},
{id:'succession', name:'Succession character', as:'a Succession character', color:'#1f2a36', items:[
  ["Logan Roy",-1,-1,1,-1,"Built the empire, trusts no one, ends meetings with one word."],
  ["Kendall Roy",1,0.5,1,-1,"Believes this time is the time. It is not."],
  ["Roman Roy",-0.5,1,0,1,"Jokes as armor, armor as personality."],
  ["Shiv Roy",-1,0.5,0,0,"Smartest in the room, and needs you to know it."],
  ["Connor Roy",1,0.5,-1,0.5,"A ranch in New Mexico and a presidential run nobody asked for."],
  ["Tom Wambsgans",-0.5,0,0.5,1,"Midwestern, ambitious, suffering beautifully in a nice suit."],
  ["Cousin Greg",0,-1,-1,1,"Tall, apologetic, somehow still in the room."],
  ["Gerri Kellman",-1,-0.5,0,0.5,"Calm, lethal, has read every clause."],
  ["Willa",1,1,-0.5,0,"A playwright, technically."],
  ["Stewy",0,0.5,-1,0,"Old friend, new enemy, great hair."],
  ["Marcia",0.5,0,0.5,-1,"Says little, knows everything, leaves for Milan."],
  ["Colin",0,-1,1,-1,"Silent, enormous, always just outside the door."]
]},
{id:'girls', name:'Girls character', as:'a character on Girls', color:'#c75b7a', items:[
  ["Hannah Horvath",0.5,0.5,1,1,"A voice of a generation, give or take."],
  ["Marnie Michaels",-1,0.5,-0.5,-1,"Has a plan, a gallery job, and a song she will sing at you."],
  ["Jessa Johansson",1,1,0,1,"Arrives from abroad and leaves a wake."],
  ["Shoshanna Shapiro",-0.5,1,-1,1,"Talks fast, means every word, eventually moves to Tokyo."],
  ["Adam Sackler",1,-1,1,-1,"Builds furniture shirtless and has feelings about it."],
  ["Ray Ploshansky",-1,-1,1,0,"Runs a coffee shop and a grievance against everything."],
  ["Elijah",-0.5,1,-0.5,1,"Arch, devastating, gets the best line in every room."],
  ["Desi",1,0.5,-1,0,"Sings with a guitar and lies with his eyes."],
  ["Charlie",-0.5,-0.5,0,-1,"The nice boyfriend, until he isn't."],
  ["Caroline",1,1,1,1,"Unhinged and, now and then, right."]
]},
{id:'subway', name:'Subway line', as:'a subway line', color:'#0039a6', items:[
  ["The 1",-1,-1,-1,0,"Local, reliable, stops at Columbia. Of course it does."],
  ["The 4",-1,-0.5,0,-1,"Express, efficient, judges you for blocking the door."],
  ["The 6",-0.5,0,0.5,1,"Every stop on the Upper East Side, each one essential."],
  ["The 7",0,1,-0.5,1,"Elevated through Queens, with something delicious at every stop."],
  ["The A",-0.5,0,0,-1,"Goes the farthest of them all. Reaches the ocean, eventually."],
  ["The C",0.5,-0.5,1,0,"Slower, older, on a spiritual journey."],
  ["The F",0,0,0.5,1,"Brooklyn's Main Street. Always under construction."],
  ["The G",1,-1,0.5,1,"Never goes to Manhattan, and wants you to know that's fine."],
  ["The J",1,0,1,0,"Rattles over the bridge like it's the early twentieth century."],
  ["The L",-0.5,1,-1,0,"Williamsburg to Union Square with a tote bag."],
  ["The Q",-1,0.5,-1,-1,"Over the bridge at sunset, then all the way to Coney Island."],
  ["The R",0.5,-0.5,1,-1,"Famously slow. Less a train than a meditation."],
  ["The Shuttle",1,0.5,-0.5,-1,"Two stops. A whole life."]
]},
{id:'core', name:'Core Curriculum text', as:'a Core Curriculum text', color:'#6c8ebf', items:[
  ["The Iliad",-0.5,0.5,1,-1,"One man's rage, sung for twenty-four books."],
  ["The Odyssey",0,0.5,-0.5,1,"Takes the long way home, lies to everyone, utterly charming."],
  ["The Oresteia",0.5,0,1,0,"A family curse settled, at last, by a jury."],
  ["The Symposium",1,1,-0.5,1,"A drinking party where everyone gives a speech about love."],
  ["The Republic",1,-0.5,0,-1,"Designs the perfect city, then bans the poets."],
  ["Augustine's Confessions",1,0,1,-1,"Stole some pears once. Has been thinking about it ever since."],
  ["The Inferno",1,1,1,0,"A guided tour, nine circles deep."],
  ["The Book of Job",1,-1,1,-1,"Lost everything and got a whirlwind instead of an answer."],
  ["Montaigne's Essays",-0.5,0,-0.5,1,"What do I know? Here are 107 essays on the subject."],
  ["Don Quixote",1,1,-1,1,"Tilts at windmills and is, in a sense, right."],
  ["Leviathan",-1,-1,1,-1,"Life is nasty, brutish and short. Get a sovereign."],
  ["Pride and Prejudice",-1,0.5,-1,0,"A good marriage and a better comeback."],
  ["On the Genealogy of Morals",-0.5,0.5,1,1,"Traces your conscience back to an unpaid debt."]
]},
{id:'noise', name:'Noise your apartment makes at night', as:'a noise your apartment makes at night', color:'#3b3561', items:[
  ["Radiator clank",-1,-1,0,-1,"Bangs once, hard, at 3 a.m., for no reason."],
  ["Upstairs footsteps",-0.5,-0.5,1,1,"Is he moving furniture? At this hour? Again?"],
  ["Fridge hum",0,-1,-0.5,0,"A low, eternal, oddly reassuring drone."],
  ["Knocking pipes",0.5,0,1,0,"Something is traveling through the walls."],
  ["Mouse in the wall",0,0,0.5,1,"Scritch. Pause. Scritch."],
  ["Car alarm",-1,1,-1,1,"Six songs in a row, none of them good."],
  ["Distant siren",0.5,0,1,-1,"Somebody else's emergency, Doppler-shifted."],
  ["The neighbors, again",-0.5,1,-0.5,-1,"Rhythmic, enthusiastic, through the wall."],
  ["Wind in the window gap",1,-0.5,0,0,"A whistle that sounds almost like your name."],
  ["Ice maker",-1,0,-0.5,0.5,"Drops a load of ice like a slot machine paying out."],
  ["5 a.m. garbage truck",-1,0.5,0.5,-1,"Hydraulic groan, a crash of glass, dawn."],
  ["A single floorboard",1,-1,0.5,-1,"One creak. Nobody's there. Probably."],
  ["The cat at 4 a.m.",0.5,1,-1,1,"A thunder of tiny feet, then a crash."]
]},
{id:'bodega', name:'Thing behind the bodega counter', as:'a thing behind the bodega counter', color:'#d1453b', items:[
  ["Scratch-offs",1,0.5,-1,1,"Hope, on a roll, two dollars a square."],
  ["The bodega cat",1,0,0,-1,"Asleep on the bread. Runs the place."],
  ["Loosies",-0.5,-0.5,1,0,"Sold one at a time, technically not allowed."],
  ["Phone chargers",-1,-1,-0.5,1,"Every connector except yours."],
  ["Bacon, egg and cheese",-1,-0.5,0,-1,"The answer to most questions before noon."],
  ["Wall of blunt wraps",0.5,0.5,0.5,0.5,"Every flavor, in a glowing rainbow."],
  ["Plantain chips",-0.5,0,-1,0,"Salty, crunchy, a hint of somewhere warmer."],
  ["Prayer candles",1,1,1,-1,"Saint Jude, Our Lady of Guadalupe, two ninety-nine."],
  ["Advil in tiny packets",-1,-1,1,0,"Two pills in foil and a long night ahead."],
  ["The card-minimum sign",-0.5,-1,0.5,-1,"Laminated, firm, non-negotiable."],
  ["Arizona iced tea",-0.5,0.5,-1,-1,"The price is printed on the can. A small miracle."],
  ["Patties under the heat lamp",0,0.5,0.5,1,"Something golden, turning slowly in the light."]
]},
{id:'grudge', name:'Kind of grudge', as:'a kind of grudge', color:'#7d2e2e', items:[
  ["Petty grudge",-1,0.5,-1,1,"Remembers exactly who didn't chip in for the cab."],
  ["Blood feud",0,0.5,1,-1,"Three generations, one goat, no forgiveness."],
  ["Silent grudge",0.5,-1,1,-1,"Never mentioned. Never forgotten."],
  ["Grudge against a stranger",1,0,0,1,"The man on the train in 2014 who looked at you funny."],
  ["Grudge against an institution",-1,-1,0,1,"You and the DMV. You and the utility company. You and all of them."],
  ["Grudge against yourself",1,0,1,0,"Your own worst enemy, and you've never forgiven them."],
  ["Professional grudge",-1,-0.5,0.5,-1,"Kept in a spreadsheet, updated quarterly."],
  ["Literary grudge",0.5,1,0.5,0,"A bad review, answered years later in a novel."],
  ["Grudge you forgot the reason for",1,-0.5,-0.5,0.5,"Still angry. Can't remember why. Doesn't matter."],
  ["Public grudge",-0.5,1,0,-1,"Announced at a dinner party, with a toast."],
  ["Grudge against a chair",0,0,-1,-1,"You know what it did."],
  ["Inherited grudge",0.5,0,1,1,"Your mother's, and her mother's, and now yours."]
]},
{id:'haunting', name:'Kind of haunting', as:'a haunting', color:'#5e6b5a', items:[
  ["Poltergeist",-0.5,1,-0.5,1,"Throws things, slams doors, needs attention."],
  ["Gray lady",1,0,1,-1,"Drifts down the same hallway at the same hour, forever."],
  ["Headless horseman",-0.5,1,1,-1,"Rides. Searches. Has one goal."],
  ["Residual haunting",-1,-1,0,-1,"Not a ghost, exactly. A recording on a loop."],
  ["Banshee",1,1,1,0,"Wails before a death in the family."],
  ["Friendly ghost",-1,0,-1,0,"Mostly misunderstood. Would like a hug."],
  ["Haunted doll",0,0.5,0.5,0,"Its eyes follow you. Its position changes."],
  ["Ghost who doesn't know",1,-0.5,-0.5,1,"Still setting the table. Still waiting for a call."],
  ["Haunted mansion",0.5,1,0,1,"Every room, a different tragedy."],
  ["Shadow person",0,-1,1,0,"In the corner of your eye. Gone when you look."],
  ["Abandoned subway station",-0.5,-0.5,1,1,"A figure on a platform where no train stops."],
  ["Ghost in the machine",-1,-0.5,0,1,"Glitches your phone at exactly 3:33."]
]},
{id:'victorian', name:'Victorian cause of death', as:'a Victorian cause of death', color:'#4a4238', items:[
  ["Consumption",1,1,1,-1,"Pale, romantic, coughing poetry into a handkerchief."],
  ["Arsenic wallpaper",-0.5,1,0,0,"Died of a beautiful shade of green."],
  ["Cholera",-1,-1,1,1,"Bad water, a quick end, and eventually some very good sewers."],
  ["Crinoline fire",-0.5,1,-1,-1,"A dress, a fireplace, a moment's inattention."],
  ["Runaway omnibus",-1,-0.5,-1,0,"A crowded street and a fatal hurry."],
  ["Melancholy",1,0,1,0,"Officially a 'decline.' Really, a broken heart."],
  ["Laudanum",1,0.5,0,1,"A little something for the nerves, then a little more."],
  ["Factory machinery",-1,-1,0,-1,"Industry, efficiency, an unguarded loom."],
  ["Mercury poisoning",0.5,0.5,0,1,"Mad as a hatter, literally."],
  ["Scarlet fever",0,0,0.5,-1,"A fever, and a quarantine notice nailed to the door."],
  ["Duel",0,1,0.5,-1,"A matter of honor at dawn on a foggy heath."],
  ["Brain fever",1,-0.5,0,1,"A novelist's diagnosis. Nobody knows what it was."]
]},
{id:'pockets', name:"Thing in a dead man's pocket", as:"a thing in a dead man's pocket", color:'#2b2b2b', items:[
  ["A single key",-1,-1,0,-1,"No ring, no tag. Just the one."],
  ["An unscratched lottery ticket",1,0,-1,0,"You decide whether to look."],
  ["An unsent love letter",1,1,1,-1,"Folded small, read many times, never mailed."],
  ["A receipt for one coffee",-1,-0.5,-1,0,"Timestamped 8:14 a.m. A normal day."],
  ["A stopped pocket watch",0.5,0.5,0.5,-1,"Stopped at a time that must mean something."],
  ["Seventeen dollars and a button",-0.5,0,0,1,"The button matches nothing he was wearing."],
  ["A photo of a stranger",1,0,1,0.5,"Nobody in the family recognizes her."],
  ["A one-way train ticket",0,0,-0.5,1,"For tomorrow."],
  ["A tooth",0.5,0.5,1,1,"Wrapped carefully in a handkerchief. Not his."],
  ["A rosary",1,-0.5,0.5,-1,"Worn smooth at one bead."],
  ["A grocery list",-1,-1,0,1,"Eggs, milk, apologize."],
  ["A handful of sand",1,-1,-0.5,1,"From a beach nowhere near here."],
  ["One pearl earring",0,1,0,0,"Its match is somewhere."]
]}
];

WT.slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

// answers: array of 12 zeros (left) and ones (right) -> {M,O,H,F}
WT.shape = answers => {
  const s = {M:0,O:0,H:0,F:0}, n = {M:0,O:0,H:0,F:0};
  WT.questions.forEach((q,k)=>{ s[q.ax] += answers[k] ? -q.s : q.s; n[q.ax]++; });
  for(const k in s) s[k] /= n[k];
  return s;
};

// distance: angle between your shape and the thing (cosine), blended with plain distance
// so things near the middle don't win everything
WT.dist = (it, sh) => {
  const v=[it[1],it[2],it[3],it[4]], u=[sh.M,sh.O,sh.H,sh.F];
  const nv=Math.hypot(...v)||1, nu=Math.hypot(...u)||1;
  const cos=v.reduce((a,x,k)=>a+x*u[k],0)/(nv*nu);
  return (1-cos) + WT.mix*Math.hypot(...v.map((x,k)=>x-u[k]));
};
WT.mix = 0.15;

// ranked things in a category for a shape
WT.rank = (cat, sh) => cat.items.map((it,idx)=>{
  const d = WT.dist(it, sh);
  return {idx, name:it[0], blurb:it[5], more:it[6]||'', slug:WT.slug(it[0]), d, match:Math.max(1,Math.round(100*(1 - d/2.6)))};
}).sort((a,b)=>a.d-b.d || a.idx-b.idx);

if (typeof module !== 'undefined') module.exports = WT;
