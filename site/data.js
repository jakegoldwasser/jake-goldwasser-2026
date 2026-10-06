/* Content for the live homepage (index.html), kept apart from /tweak/ so
   experiments there never change the real site. Everything is taken from the live
   site (index.html, writing.html, illustrations.html); each option renders
   it its own way. Sections follow the live site: Me, Words, Pictures,
   Bookbug. No teaching links on purpose: tutoring stays its own site. */
window.JG = {
  name: "Jake Goldwasser",
  /* the bio, verbatim, split so each option can link the key words */
  bio: "I write poems, draw cartoons for the New Yorker, and translate from Dutch and Ladino. I live and teach in New York.",
  bioHTML: function (cls) {
    cls = cls || {};
    return 'I write <a href="#words/poem" class="' + (cls.poem || "") + '">poems</a>, draw <a href="#pictures" class="' + (cls.comic || "") + '">cartoons</a> for the New&nbsp;Yorker, and <a href="#words/trans" class="' + (cls.trans || "") + '">translate</a> from Dutch and Ladino. I live and teach in New&nbsp;York.';
  },
  /* the full bio behind the homepage's More button: the live About
     page's paragraphs, minus the first line the bio already says */
  bioMore: [
      "You can find my poetry in the New England Review, Image, <a href=\"https://www.benningtonreview.org/thirteen-goldwasser\" target=\"_blank\" rel=\"noopener\">Bennington Review</a>, and elsewhere. I hold an MFA in creative writing from the University of Iowa.",
      "My cartoons and comics appear in <a href=\"https://www.newyorker.com/humor/daily-shouts/what-thanksgiving-dishes-mean\" target=\"_blank\" rel=\"noopener\">the New Yorker</a>, Narrative, <a href=\"https://www.cartoonstock.com/search?cartoonist=jakegoldwasser%2CJake%20Goldwasser&page=1&sort=most_popular&type=images\" target=\"_blank\" rel=\"noopener\">Air Mail</a>, Reader&rsquo;s Digest, as a weekly feature in <a href=\"https://sundaylongread.com\" target=\"_blank\" rel=\"noopener\">the Sunday Long Read</a>, and as part of an exhibition at the <a href=\"https://www.materialinheritance.com/jake-goldwasser\" target=\"_blank\" rel=\"noopener\">Jewish Museum of Maryland</a>.",
      "I am also a translator. My translation of Judith Herzberg&rsquo;s chapbook <em>Landscape</em> (Dutch) was published by Circumference Books (2022). I was a finalist for the Peirene Stevns Translation Prize 2024. I hold an MFA in literary translation from the University of Iowa, and am an official translator recognized by the Dutch Foundation for Literature.",
      "I have been a fellow at Fulbright, New Jewish Culture Fellowship, UNESCO, and PJ Libraries and have worked as a linguist at Khan Academy, Google, and elsewhere."
  ],
  /* Recent on the homepage: cards for things that can be clicked through
     to, newest first. Only add items with a url. k picks the color
     (poem, trans, prose, comic); label overrides the kind's name. */
  recent: [
    { k: "comic", t: "“Furniture Arrangements for Your Therapist’s Office”", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/furniture-arrangements-for-your-therapists-office" },
    { k: "poem", t: "“The News”", v: "Gotham Literature", url: "https://www.gothamliterature.nyc/content/the-news" },
    { k: "trans", t: "“Jaguar Man” by Raoul de Jong", v: "From the Dutch · Words Without Borders", url: "https://wordswithoutborders.org/read/article/2024-05/jaguar-man-raoul-de-jong-jake-goldwasser/" }
  ],
  poemLine: "I smoked what was left of my pipe and tidied my house. I thought about how alone I would look if a camera was hidden. I folded a few months of laundry and spackled the drawers. I gathered the cobwebs and laid them onto a plate one strand at a time. I imagined a hammock’s day in the mild sun. I twisted the clock to display a time I preferred.",
  /* a few facts from the live About page, for options that want a
     second, quieter layer under the bio */
  facts: [
    ["Poems", "New England Review, Image, Bennington Review"],
    ["Cartoons", "The New Yorker, Narrative, Air Mail, the Sunday Long Read (weekly)"],
    ["Translation", "Landscape by Judith Herzberg, Circumference Books, 2022"],
    ["Training", "MFAs in poetry and literary translation, University of Iowa"]
  ],
  /* the four Words sections, in the live site's order and wording */
  order: ["poem", "trans", "prose", "comic"],
  kinds: {
    poem:  { label: "Poetry",            one: "Poem" },
    trans: { label: "Translation",       one: "Translation" },
    prose: { label: "Nonfiction",        one: "Nonfiction" },
    comic: { label: "Comics",            one: "Comic" }
  },
  works: [
    { k: "poem", t: "The News", v: "Gotham Literature", url: "https://www.gothamliterature.nyc/content/the-news" },
    { k: "poem", t: "a new kind of music", v: "Volume Poetry", url: "https://volumepoetry.com/a-new-kind-of-music-Jake-Goldwasser" },
    { k: "poem", t: "Griddle", also: "Arjun sits weaponless in his chariot", v: "Bennington Review", url: "https://www.benningtonreview.org/thirteen-goldwasser" },
    { k: "poem", t: "The Jewish longing for wilderness reveals itself", v: "Image", url: "https://imagejournal.org/article/the-jewish-longing-for-wilderness-reveals-itself/" },
    { k: "poem", t: "Translation of No Particular Love Poem", also: "The Kitchen’s Lament", v: "Oxford Poetry" },
    { k: "poem", t: "Psittacine", v: "New England Review" },
    { k: "poem", t: "The weather in Brooklyn", also: "The Moonshine Economy", v: "Grist" },
    { k: "poem", t: "Parallax", v: "Volume Poetry" },
    { k: "poem", t: "Martingale", v: "The Spectacle", url: "https://thespectacle.wustl.edu/?p=1271" },

    { k: "trans", t: "Quatrains", by: "Jacob Israël de Haan", lang: "Dutch", v: "Massachusetts Review" },
    { k: "trans", t: "Poems", by: "Eva Gerlach", lang: "Dutch", v: "Five Points" },
    { k: "trans", t: "Tree of Life", by: "Avner Perets", lang: "Ladino", v: "Verklempt!", note: "Forthcoming" },
    { k: "trans", t: "Two poems", by: "Avner Perets", lang: "Ladino", v: "Denver Quarterly" },
    { k: "trans", t: "Jaguarman (excerpt)", by: "Raoul De Jong", lang: "Dutch", v: "Words Without Borders", url: "https://wordswithoutborders.org/read/article/2024-05/jaguar-man-raoul-de-jong-jake-goldwasser/" },
    { k: "trans", t: "Quatrains", by: "Jacob Israël de Haan", lang: "Dutch", v: "The Baffler", url: "https://thebaffler.com/authors/jake-goldwasser" },
    { k: "trans", t: "Landscape", by: "Judith Herzberg", lang: "Dutch", v: "Circumference Books", note: "Book, 2022" },

    { k: "prose", t: "Australia", v: "New Delta Review", url: "http://ndrmag.org/nonfiction/2024/05/australia-by-jake-goldwasser/" },
    { k: "prose", t: "A conversation with Arthur Sze", v: "Translators Note", url: "https://exchanges.uiowa.edu/features/conversations-arthur-sze/", note: "Audio" },
    { k: "prose", t: "A conversation with Margaret Ross", v: "Translators Note", url: "https://exchanges.uiowa.edu/translators-note/", note: "Audio" },
    { k: "prose", t: "Jewish Havens: Amsterdam, The Netherlands", v: "Public Books", url: "https://www.publicbooks.org/author/jake-goldwasser/" },
    { k: "prose", t: "On Raʼad Abdulqadir’s Except for This Unseen Thread", v: "Asymptote", url: "https://www.asymptotejournal.com/criticism/raad-abdulqadir-except-for-this-unseen-thread/" },
    { k: "prose", t: "From Aspiring Cartoonist to The New Yorker", v: "Lit Hub" },
    { k: "prose", t: "“Next stop Armageddon”: On Cees Nooteboom’s Leaving", v: "Cleveland Review of Books" },

    { k: "comic", t: "Thought Experiment", v: "Carte Blanche", url: "https://carteblanchemagazine.com/issue-49/goldwasser-thought-experiment" },
    { k: "comic", t: "Standard Pest Control", v: "Florida Review", url: "https://floridareview.cah.ucf.edu/article/standard-pest-control/", note: "Nominated for Best of the Net" },
    { k: "comic", t: "Furniture Arrangements for Your Therapist’s Office", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/furniture-arrangements-for-your-therapists-office" },
    { k: "comic", t: "Situations in Which You Absolutely Must Check Your Email", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/situations-in-which-you-absolutely-must-check-your-e-mail" },
    { k: "comic", t: "Fixing Gen Z’s Etiquette Problem", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/fixing-gen-zs-etiquette-problem" },
    { k: "comic", t: "Five Raccoons Whose Careers Were More Illustrious Than Yours", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/five-raccoons-whose-careers-were-more-illustrious-than-yours" },
    { k: "comic", t: "Puppies Who Are Sad for Totally Legitimate Reasons", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/puppies-who-are-sad-for-totally-legitimate-reasons" },
    { k: "comic", t: "What Thanksgiving Dishes Mean", v: "The New Yorker", url: "https://www.newyorker.com/humor/daily-shouts/what-thanksgiving-dishes-mean" },
    { k: "comic", t: "Some Recent Ergonomic Trends", v: "The New Yorker" }
  ],
  /* the live Pictures gallery, same files and row weights (see
     illustrations.html for what the weights mean). t is the file's own
     name where it has one; the rest go uncaptioned rather than guessed. */
  picBase: "https://images.squarespace-cdn.com/content/v1/5dd04d65e4888e546892880a/",
  pictures: [
    { p: "a0feff05-0206-46cb-b2d7-3dcd9fb4cc43/img20241130_15144631.jpg", w: 1.6 },
    { p: "7ae49ae6-5423-4e88-b62c-0bb84f356e13/img20260120_18514801.jpg", w: 1.6 },
    { p: "abbf7c15-80d8-401a-908b-feb580256ad6/img20260104_08481398+copy.jpg", w: 1.6 },
    { p: "7244b148-e038-4250-97e1-978fadb5ddcc/Untitled+design+%281%29.png", w: 1.6 },
    { p: "1703461545645-5SAXZ41YY5GWGU2CH9O3/French+Bulldog.jpeg", w: 0.6, t: "French Bulldog" },
    { p: "1703461554184-D551UPD079Q46GDBRBPR/Portuguese+Water+Dog.jpeg", w: 0.6, t: "Portuguese Water Dog" },
    { p: "1703461517761-T9633B2Y73Z9454H76PI/Mashed+Potatoes.png", w: 0.6, t: "Mashed Potatoes" },
    { p: "1603052641161-DFBVRXYCMS98RNABK0OF/Jake_Goldwasser_Cartoonist.jpg", w: 0.6 },
    { p: "2fe7ffcc-5a90-48c7-83e6-3dff9a6f69f5/Screenshot+2023-12-24+at+7.22.54+PM.png" },
    { p: "1703461512068-49HCGTTAE1XYV18KZJ24/Green+Beans.png", w: 0.6, t: "Green Beans" },
    { p: "df147242-6f40-4757-89ae-17d996d86dc9/Screenshot+2023-12-24+at+7.23.46+PM.png" },
    { p: "1703461480580-OAZ7YETR408CRJQPSGNV/Beagle.jpeg", w: 0.6, t: "Beagle" },
    { p: "d85a44b3-7040-4501-b53b-56759f57f591/Screenshot+2023-12-24+at+7.23.12+PM.png" },
    { p: "1703461522040-7HKY885EDYCH0CZDN5V7/Stuffing.png", w: 0.6, t: "Stuffing" },
    { p: "1703461511986-KQPKPN3H3M2W1ODN5IME/Cranberry+Sauce.png", w: 0.6, t: "Cranberry Sauce" },
    { p: "1703461517128-HKJ60YHBZQPFAL810KDR/Pumpkin+Pie.png", w: 0.6, t: "Pumpkin Pie" },
    { p: "93ec7512-9e58-41b4-89da-6f9a8d26e157/Landscape.jpeg", w: 1.6, t: "Landscape" },
    { p: "3aeb2746-c843-4466-8700-89d5bbe9f340/Mold_Pages_6-7.jpg", t: "Mold, pages 6–7" },
    { p: "494bfafe-30c1-4a3f-a901-1882e800d110/Screenshot+2023-12-24+at+7.22.16+PM.png" },
    { p: "9d5eb493-f416-4fae-8bf3-6d38b2abb2f6/Screenshot+2023-12-24+at+7.22.41+PM.png" },
    { p: "1703461546534-1WUVX0FVFH7KIK9UJVO5/Hendrix.jpeg", w: 0.6, t: "Hendrix" },
    { p: "1703461559076-FNWFAUNX63QTPNLYRTBB/the-great-pacific-pumpkin-patch-jake-goldwasser.jpg", w: 1.6, t: "The Great Pacific Pumpkin Patch" },
    { p: "55ad9918-bd01-47ba-97df-37d0e0529e0f/0001.jpg", w: 1.15 },
    { p: "69181ecc-6414-4045-97f7-95f8c874e37a/Olympic+Fare+Evasion.jpg", t: "Olympic Fare Evasion" },
    { p: "0af382c6-3e23-4a1f-b5e7-c4c4f7d432b9/Screenshot+2025-03-08+at+10.04.55%E2%80%AFAM.png" },
    { p: "6e41dfd2-2011-4ad2-8693-40240237b966/img20240423_09521442.jpg", w: 1.9 },
    { p: "1703461556818-WBZPHVFM29VK05ARJ47H/img20220930_10002329.jpeg", w: 1.15 },
    { p: "6fbf26eb-4791-4952-b959-e759af9d87d6/a-charming-wedding-venue-jake-goldwasser.jpg", t: "A Charming Wedding Venue" },
    { p: "1703461479625-R9NEKRH6WDJ5R565S4WD/5.jpg" },
    { p: "1e283c09-71dd-414b-a8bc-27add53988fe/Screenshot+2025-03-08+at+10.13.23%E2%80%AFAM.png" }
  ],
  /* the drawing every option features on Me: Jake's self-portrait
     (Jake_Goldwasser_Cartoonist.jpg), shown without a caption */
  FEATURE: 7,
  links: {
    bookbug: "/bookbug/",
    instagram: "https://www.instagram.com/jakegoldwasser/",
    longread: "https://sundaylongread.com",
    museum: "https://www.materialinheritance.com/jake-goldwasser"
  }
};
