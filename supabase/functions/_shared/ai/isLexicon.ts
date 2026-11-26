/**
 * Icelandic intent vocabulary (roadmap item 8). GENERATED from the approved intent-vocabulary.json
 * (schemaVersion 1, sourceCommit e89402b12da395f8d819afa7deb11371edbffc1b) — do not edit by hand; regenerate instead.
 *
 * These are the authored Icelandic surface forms, kept verbatim (NFC). Code derives folded lookup keys from them
 * (foldIs: NFD, combining marks removed, lower case; æ, ð and þ stay distinct letters). Pure data, no dependencies,
 * Deno-safe. The grammar rules that accompany the vocabulary live with the parsers (meals.ts, conversation.ts,
 * requestSignals.ts), not here.
 */

/** Matching key for an Icelandic (or English) surface form: accents dropped, æ/ð/þ kept, lower case. */
export const foldIs = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export const IS_VOCAB = {
  "meal_plan": {
    "tokens": [
      "matseðill",
      "matseðil",
      "matseðlinum",
      "matseðils",
      "matseðlar",
      "matseðla",
      "matseðlum",
      "matarplan",
      "matarplanið",
      "matarplani",
      "matarplans",
      "mataráætlun",
      "mataráætlunina",
      "vikumatseðill",
      "vikumatseðil"
    ],
    "phrases": [
      "gerðu matseðil",
      "útbúðu matseðil",
      "búðu til matseðil",
      "settu saman matseðil",
      "skipuleggðu máltíðirnar",
      "skipuleggðu matinn",
      "matseðill fyrir næstu viku",
      "bættu matseðlinum við"
    ]
  },
  "program": {
    "tokens": [
      "æfingaáætlun",
      "æfingaáætlunina",
      "æfingaáætlunar",
      "æfingaplan",
      "æfingaplanið",
      "æfingaplani",
      "æfingaplans",
      "æfingaprógramm",
      "æfingaprógrammið",
      "prógramm",
      "prógrammið",
      "prógrammi",
      "prógramms"
    ],
    "verbs": [
      "búðu til",
      "útbúðu",
      "settu saman",
      "gerðu",
      "hannaðu",
      "skrifaðu",
      "mig vantar",
      "ég vil nýja",
      "ég vil nýtt"
    ],
    "phrases": [
      "búðu til nýja æfingaáætlun",
      "mig vantar þriggja daga prógramm",
      "settu saman fjögurra daga æfingaplan",
      "nýtt prógramm fyrir mig"
    ],
    "negativePhrases": [
      "ekki búa til nýtt prógramm",
      "ekki breyta æfingaáætluninni",
      "útskýrðu prógrammið"
    ]
  },
  "recipes": {
    "tokens": [
      "uppskrift",
      "uppskriftina",
      "uppskriftar",
      "uppskriftir",
      "uppskriftum",
      "uppskrifta",
      "matarhugmynd",
      "matarhugmyndir",
      "máltíðarhugmyndir"
    ],
    "phrases": [
      "hvað get ég borðað",
      "hvað ætti ég að borða",
      "hvað á ég að elda",
      "hvað get ég eldað",
      "hvað get ég búið til",
      "hugmyndir að kvöldmat",
      "hugmynd að hádegismat",
      "finndu uppskrift",
      "sýndu mér uppskriftir",
      "eitthvað í kvöldmat"
    ]
  },
  "week_adjustment": {
    "phrases": [
      "ég get bara æft tvisvar í þessari viku",
      "ég næ bara einni æfingu í vikunni",
      "ég kemst ekki á æfingu á föstudaginn",
      "færðu æfinguna yfir á laugardag",
      "skiptu um æfingadaga þessa viku",
      "breyttu vikunni",
      "sleppum æfingunni á morgun",
      "ég þarf að færa æfingu",
      "ég get aðeins æft þrisvar"
    ]
  },
  "follow_up": {
    "affirm": [
      "já",
      "já takk",
      "já, endilega",
      "endilega",
      "gerðu það",
      "gerðu þetta",
      "gott og vel",
      "hljómar vel",
      "það hljómar vel",
      "allt í lagi",
      "ókei",
      "okei",
      "oki",
      "jæja, prófaðu aftur"
    ],
    "retry": [
      "prófaðu aftur",
      "reyndu aftur",
      "prófaðu núna",
      "reyndu núna",
      "prófaðu það aftur",
      "reyndu þetta aftur",
      "nú máttu prófa",
      "prófum aftur",
      "gengur það núna"
    ],
    "sharingChanged": [
      "ég kveikti á þessu",
      "ég kveikti á deilingu",
      "ég er búinn að deila",
      "ég er búin að deila",
      "nú er búið að deila",
      "búið að kveikja",
      "ég breytti stillingunum",
      "núna máttu sjá þetta"
    ],
    "gratitudeOnly": [
      "takk",
      "takk fyrir",
      "takk kærlega",
      "frábært, takk",
      "takk samt"
    ],
    "negative": [
      "nei",
      "nei takk",
      "ekki gera það",
      "ekki prófa aftur",
      "hættu við",
      "sleppum því",
      "bíðum aðeins",
      "ekki núna"
    ]
  },
  "session_shorten": {
    "phrases": [
      "ég hef lítinn tíma",
      "ég hef bara tíu mínútur",
      "ég hef korter eftir",
      "styttu æfinguna",
      "styttum æfinguna",
      "styttri æfing í dag",
      "ég þarf að klára fyrr",
      "ég er að flýta mér",
      "hvað get ég sleppt",
      "taktu út síðustu settin",
      "bara þessa æfingu",
      "ekki breyta áætluninni"
    ]
  },
  "session_swap": {
    "verbs": [
      "skipta út",
      "skiptu út",
      "skiptu um",
      "skipta um",
      "setja í staðinn",
      "settu í staðinn",
      "gera í staðinn",
      "nota í staðinn"
    ],
    "phrases": [
      "búnaðurinn er upptekinn",
      "tækið er upptekið",
      "bekkurinn er upptekinn",
      "stöngin er upptekin",
      "rekkið er upptekið",
      "handlóðin eru upptekin",
      "allt er upptekið",
      "þetta tæki er ekki laust",
      "ég hef ekki þetta tæki",
      "tækið er bilað",
      "hvað get ég gert í staðinn",
      "má ég nota handlóð í staðinn",
      "aðeins í dag"
    ]
  },
  "explain": {
    "phrases": [
      "útskýrðu þetta",
      "af hverju þetta",
      "hvers vegna þetta",
      "af hverju á ég að hækka",
      "af hverju á ég ekki að hækka",
      "af hverju lægri þyngd",
      "hvað þýðir þetta",
      "hvernig er næsta þyngd ákveðin",
      "hvað þýðir RIR",
      "hvað eru endurtekningar í varasjóði"
    ]
  },
  "fatigue": {
    "tokens": [
      "þreyta",
      "þreytu",
      "þreytan",
      "þreytt",
      "þreyttur",
      "þreytta",
      "þreyttan",
      "þreyttir",
      "þreyttar",
      "örþreytt",
      "örþreyttur",
      "örmagna",
      "örmögnun",
      "úrvinda",
      "uppgefin",
      "uppgefinn",
      "uppgefið",
      "orkulaus",
      "orkulausir",
      "orkulaust",
      "orkulítil",
      "orkulítill",
      "orkulítið",
      "syfjuð",
      "syfjaður",
      "syfjað"
    ],
    "phrases": [
      "búin á því",
      "búinn á því",
      "búið á því",
      "alveg búin",
      "alveg búinn",
      "ég á ekkert eftir",
      "ég hef enga orku",
      "lítil orka",
      "lítið þrek",
      "ég svaf illa",
      "ég svaf lítið",
      "ég hef ekki sofið",
      "ég er útkeyrð",
      "ég er útkeyrður"
    ],
    "foodBoredomPatterns": [
      "þreytt á kjúklingi",
      "þreyttur á kjúklingi",
      "þreytt á að borða þetta",
      "leið á kjúklingi",
      "leiður á kjúklingi",
      "leið á þessum mat",
      "komið nóg af kjúklingi"
    ],
    "typographicalAliases": {
      "úrvindur": "úrvinda"
    },
    "contextualHints": [
      "eftir næturvakt",
      "með ungabarn"
    ]
  },
  "pain_discomfort": {
    "tokens": [
      "verkur",
      "verk",
      "verkir",
      "verki",
      "verkjum",
      "sársauki",
      "sársauka",
      "óþægindi",
      "óþægindum",
      "meiðsli",
      "meiðslum",
      "meidd",
      "meiddur",
      "meiddan",
      "meiddri",
      "bólga",
      "bólgu",
      "eymsli",
      "eymslum",
      "svimi",
      "svima",
      "ógleði"
    ],
    "phrases": [
      "mér er illt",
      "mér er illt í",
      "ég finn til",
      "þetta er vont",
      "þetta særir",
      "ég meiddi mig",
      "ég er með verki",
      "það stingur í",
      "þrýstingur í brjósti",
      "verkur fyrir brjósti",
      "ég er lasin",
      "ég er lasinn",
      "ég er veik",
      "ég er veikur"
    ],
    "bodyParts": [
      "öxl",
      "öxlin",
      "öxlinni",
      "axlir",
      "axlanna",
      "axlar",
      "hné",
      "hnéð",
      "hnén",
      "hnénu",
      "hnélið",
      "bak",
      "bakið",
      "bakinu",
      "mjóbak",
      "mjóbakinu",
      "mjöðm",
      "mjöðmin",
      "mjöðminni",
      "nári",
      "nárinn",
      "nára",
      "úlnliður",
      "úlnlið",
      "úlnliðnum",
      "olnbogi",
      "olnboga",
      "olnboganum",
      "ökklinn",
      "ökkli",
      "ökkla",
      "háls",
      "hálsinn"
    ],
    "negativePhrases": [
      "enginn verkur",
      "ég finn ekki til",
      "engin óþægindi",
      "ekkert illt",
      "engin meiðsli",
      "ekki meidd",
      "ekki meiddur"
    ]
  },
  "nutrition_protein": {
    "tokens": [
      "prótein",
      "próteins",
      "próteini",
      "próteininnihald",
      "próteinríkt",
      "próteinríkur",
      "próteinrík",
      "próteinríka",
      "próteinríkar",
      "próteinríkar máltíðir",
      "próteinmarkmið",
      "próteinduft",
      "hitaeiningar",
      "hitaeiningum",
      "hitaeininga",
      "kaloríur",
      "kolvetni",
      "kolvetna",
      "fita",
      "fitu",
      "trefjar",
      "trefjum",
      "næring",
      "næringu",
      "næringarmarkmið"
    ],
    "phrases": [
      "meira prótein",
      "hátt próteininnihald",
      "minna af kolvetnum",
      "prótein í hverjum skammti",
      "hversu mikið prótein",
      "hvað á ég mikið eftir",
      "hvað vantar upp á markmiðið"
    ]
  },
  "meal_slots": {
    "map": {
      "breakfast": [
        "morgunmatur",
        "morgunmat",
        "morgunmatinn",
        "morgunmatnum",
        "morgunverður",
        "morgunverð",
        "morgunverðinn",
        "morgunverðar",
        "bröns",
        "brönsinn"
      ],
      "lunch": [
        "hádegismatur",
        "hádegismat",
        "hádegismatinn",
        "hádegismatnum",
        "hádegisverður",
        "hádegisverð",
        "hádegisverðinn",
        "hádegisverðar"
      ],
      "dinner": [
        "kvöldmatur",
        "kvöldmat",
        "kvöldmatinn",
        "kvöldmatnum",
        "kvöldverður",
        "kvöldverð",
        "kvöldverðinn",
        "kvöldverðar"
      ],
      "snack": [
        "millimál",
        "millimálið",
        "millimáli",
        "millimálin",
        "millimálum",
        "snarl",
        "snarlið",
        "snarli",
        "nasl",
        "naslið"
      ]
    }
  },
  "quick_food": {
    "tokens": [
      "fljótlegt",
      "fljótlegur",
      "fljótleg",
      "fljótlega",
      "fljótlegar",
      "fljótlegum",
      "snöggt",
      "snöggur",
      "snögg",
      "fljótgert",
      "fljótgerður"
    ],
    "phrases": [
      "án eldunar",
      "þarf ekki að elda",
      "ekkert sem þarf að elda",
      "tilbúið á korteri",
      "undir fimmtán mínútum",
      "hámark tuttugu mínútur",
      "ekki lengur en hálftíma"
    ]
  },
  "negation": {
    "negators": [
      "án",
      "ekki",
      "aldrei",
      "enginn",
      "engin",
      "ekkert",
      "engan",
      "enga",
      "engar",
      "engir",
      "engum",
      "engri",
      "engra",
      "engrar",
      "engu",
      "engins",
      "enginnar",
      "hvorki",
      "né",
      "sleppa",
      "sleppi",
      "sleppum",
      "slepptu",
      "sleppið",
      "forðast",
      "forðastu",
      "útiloka",
      "útilokaðu",
      "nema",
      "fyrir utan"
    ],
    "refusalPhrases": [
      "ég borða ekki",
      "ég vil ekki",
      "ég vil engan",
      "mig langar ekki í",
      "mér finnst ekki gott",
      "ég þoli ekki",
      "ég má ekki borða",
      "ég er með ofnæmi fyrir",
      "með ofnæmi fyrir",
      "ég hef ofnæmi fyrir",
      "ofnæmi fyrir",
      "ég er með óþol fyrir",
      "ég er með glútenóþol",
      "ég þoli illa"
    ],
    "joiners": [
      "og",
      "eða",
      "né",
      ",",
      "/",
      "&"
    ],
    "extenders": [
      "þar með talið",
      "þar með taldar",
      "þar með talin",
      "þar með talinn",
      "þar á meðal",
      "eins og",
      "til dæmis",
      "t.d.",
      "sérstaklega",
      "einkum",
      "jafnvel",
      "meðal annars",
      "m.a.",
      "til að mynda",
      "sem inniheldur",
      "sem innihalda",
      "sem innihelda"
    ],
    "positiveBoundaries": [
      "en",
      "heldur",
      "í staðinn",
      "ég vil",
      "ég vil helst",
      "mig langar",
      "við viljum",
      "mér finnst",
      "ég borða",
      "ég elska",
      "með after separator",
      "{{food}} er í lagi",
      "{{food}} eru í lagi"
    ],
    "trailingFillers": [
      "alls",
      "alveg",
      "yfirleitt",
      "takk",
      "vinsamlegast",
      "í matnum",
      "í matinn",
      "í máltíðunum",
      "fyrir mig",
      "fyrir kvöldmat"
    ]
  },
  "diet": {
    "map": {
      "vegan": [
        "vegan",
        "veganfæði",
        "veganfæðis",
        "veganmatur",
        "veganmat",
        "veganréttur",
        "veganrétti",
        "alfarið úr jurtaríkinu",
        "án dýraafurða"
      ],
      "vegetarian": [
        "grænmetisfæði",
        "grænmetisfæðis",
        "grænmetisæta",
        "grænmetisætur",
        "grænmetisréttur",
        "grænmetisrétti",
        "grænmetisréttir",
        "grænmetismatur",
        "grænmetismat"
      ],
      "pescatarian": [
        "pescatarian",
        "pesketarían",
        "pesketaríani",
        "fiskæta",
        "fiskætu"
      ],
      "dairy_free": [
        "án mjólkurvara",
        "mjólkurlaust",
        "mjólkurlaus",
        "mjólkurlausar",
        "mjólkurlausum",
        "án mjólkur"
      ],
      "gluten_free": [
        "án glútens",
        "án glútensins",
        "glútenlaust",
        "glútenlaus",
        "glútenlausar",
        "glútenlausum"
      ]
    },
    "negated": [
      "ég er ekki vegan",
      "ég er ekki grænmetisæta",
      "ekki lengur vegan",
      "þarf ekki að vera vegan",
      "má vera með glúteni",
      "þarf ekki að vera glútenlaust"
    ]
  },
  "weekdays": {
    "map": {
      "monday": [
        "mánudagur",
        "mánudag",
        "mánudaginn",
        "mánudags",
        "mánudagsins",
        "mánudagar",
        "mánudaga",
        "mánudagana",
        "mánudögum",
        "mánudögunum",
        "mán."
      ],
      "tuesday": [
        "þriðjudagur",
        "þriðjudag",
        "þriðjudaginn",
        "þriðjudags",
        "þriðjudagsins",
        "þriðjudagar",
        "þriðjudaga",
        "þriðjudagana",
        "þriðjudögum",
        "þriðjudögunum",
        "þri."
      ],
      "wednesday": [
        "miðvikudagur",
        "miðvikudag",
        "miðvikudaginn",
        "miðvikudags",
        "miðvikudagsins",
        "miðvikudagar",
        "miðvikudaga",
        "miðvikudagana",
        "miðvikudögum",
        "miðvikudögunum",
        "mið."
      ],
      "thursday": [
        "fimmtudagur",
        "fimmtudag",
        "fimmtudaginn",
        "fimmtudags",
        "fimmtudagsins",
        "fimmtudagar",
        "fimmtudaga",
        "fimmtudagana",
        "fimmtudögum",
        "fimmtudögunum",
        "fim."
      ],
      "friday": [
        "föstudagur",
        "föstudag",
        "föstudaginn",
        "föstudags",
        "föstudagsins",
        "föstudagar",
        "föstudaga",
        "föstudagana",
        "föstudögum",
        "föstudögunum",
        "fös."
      ],
      "saturday": [
        "laugardagur",
        "laugardag",
        "laugardaginn",
        "laugardags",
        "laugardagsins",
        "laugardagar",
        "laugardaga",
        "laugardagana",
        "laugardögum",
        "laugardögunum",
        "lau."
      ],
      "sunday": [
        "sunnudagur",
        "sunnudag",
        "sunnudaginn",
        "sunnudags",
        "sunnudagsins",
        "sunnudagar",
        "sunnudaga",
        "sunnudagana",
        "sunnudögum",
        "sunnudögunum",
        "sun."
      ]
    },
    "weekend": [
      "helgi",
      "helgin",
      "helgina",
      "helgar",
      "helgarinnar",
      "helgum",
      "um helgar",
      "um helgina",
      "bara um helgar"
    ],
    "weekdays": [
      "virkir dagar",
      "virka daga",
      "á virkum dögum",
      "virkum dögum"
    ],
    "relative": {
      "today": [
        "í dag",
        "dagurinn í dag"
      ],
      "tomorrow": [
        "á morgun"
      ],
      "yesterday": [
        "í gær"
      ],
      "dayAfterTomorrow": [
        "á hinn morgun",
        "eftir tvo daga"
      ],
      "thisWeek": [
        "þessa viku",
        "þessari viku",
        "í vikunni",
        "út vikuna"
      ],
      "nextWeek": [
        "næstu viku",
        "í næstu viku",
        "í næstu vikunni"
      ]
    },
    "notWeekdays": [
      "sunnudagssteik",
      "laugardagsnammi",
      "föstudagspítsa",
      "mánudagsmatur"
    ]
  },
  "numbers_duration": {
    "numbers": {
      "1": [
        "einn",
        "ein",
        "eitt",
        "eina",
        "einni",
        "einu"
      ],
      "2": [
        "tveir",
        "tvær",
        "tvö",
        "tvo",
        "tveimur",
        "tveggja"
      ],
      "3": [
        "þrír",
        "þrjár",
        "þrjú",
        "þrjá",
        "þremur",
        "þriggja"
      ],
      "4": [
        "fjórir",
        "fjórar",
        "fjögur",
        "fjóra",
        "fjórum",
        "fjögurra"
      ],
      "5": [
        "fimm"
      ],
      "6": [
        "sex"
      ],
      "7": [
        "sjö"
      ],
      "8": [
        "átta"
      ],
      "9": [
        "níu"
      ],
      "10": [
        "tíu"
      ],
      "15": [
        "fimmtán"
      ],
      "20": [
        "tuttugu"
      ],
      "30": [
        "þrjátíu"
      ],
      "45": [
        "fjörutíu og fimm"
      ],
      "60": [
        "sextíu"
      ]
    },
    "counts": {
      "once": [
        "einu sinni",
        "einu sinni í viku"
      ],
      "twice": [
        "tvisvar",
        "tvisvar sinnum"
      ],
      "three": [
        "þrisvar"
      ],
      "four": [
        "fjórum sinnum"
      ],
      "five": [
        "fimm sinnum"
      ],
      "six": [
        "sex sinnum"
      ]
    },
    "duration": {
      "15": [
        "korter",
        "korteri",
        "fjórðungur úr klukkustund"
      ],
      "30": [
        "hálftími",
        "hálftíma",
        "hálfa klukkustund"
      ],
      "45": [
        "þrjú korter"
      ],
      "60": [
        "klukkutími",
        "klukkutíma",
        "ein klukkustund",
        "eina klukkustund"
      ],
      "90": [
        "einn og hálfur tími",
        "einn og hálfan tíma"
      ]
    },
    "units": {
      "minutes": [
        "mínúta",
        "mínútu",
        "mínútur",
        "mínútum",
        "mín.",
        "mín"
      ],
      "hours": [
        "klukkustund",
        "klukkustundir",
        "klukkustundirnar",
        "klst.",
        "klst"
      ],
      "kilograms": [
        "kg",
        "kíló",
        "kílógrömm"
      ],
      "grams": [
        "g",
        "gramm",
        "grömm"
      ],
      "pounds": [
        "lb",
        "lbs",
        "pund"
      ],
      "seconds": [
        "sekúnda",
        "sekúndu",
        "sekúndur",
        "sekúndum",
        "sek.",
        "sek"
      ]
    }
  },
  "postprocessing": {
    "whyHeadings": [
      "Af hverju?",
      "Af hverju þetta?",
      "Hvers vegna?",
      "Rökstuðningur"
    ],
    "recipeHeadings": [
      "Hráefni",
      "Innihald",
      "Aðferð",
      "Leiðbeiningar",
      "Skref",
      "Undirbúningur"
    ],
    "quantityUnits": [
      "g",
      "kg",
      "ml",
      "dl",
      "l",
      "tsk.",
      "tsk",
      "msk.",
      "msk",
      "bolli",
      "bollar",
      "bolla",
      "geiri",
      "geirar",
      "geira",
      "sneið",
      "sneiðar"
    ],
    "skipWords": [
      "sleppa",
      "sleppt",
      "sleppum",
      "sleppi",
      "fellur niður",
      "falla niður",
      "hvíld",
      "hvíldardagur",
      "hvíldardegi",
      "ekki",
      "í staðinn"
    ]
  },
  "allergens_and_restriction_declarations": {
    "declarations": [
      "ég er með ofnæmi fyrir",
      "ég hef ofnæmi fyrir",
      "ég er með óþol fyrir",
      "ég þoli ekki",
      "má ekki innihalda",
      "mega ekki innihalda",
      "má ekki vera með",
      "má ekkert vera með",
      "ekki setja",
      "hafðu ekkert",
      "slepptu",
      "forðastu"
    ],
    "negativeDeclarations": [
      "ég er ekki með ofnæmi fyrir",
      "ég er ekki með óþol fyrir",
      "ég er ekki með hnetuofnæmi",
      "ég þoli mjólk"
    ],
    "map": {
      "milk": {
        "forms": [
          "mjólk",
          "mjólkina",
          "mjólkur",
          "mjólkinni",
          "mjólkurvörur",
          "mjólkurvörum",
          "mjólkurvara",
          "mjólkurprótein",
          "mjólkurpróteini",
          "mjólkurpróteinum",
          "mjólkurlaus",
          "mjólkurlaust",
          "mjólkurlausa",
          "mjólkurlausar"
        ],
        "foods": [
          "skyr",
          "jógúrt",
          "ostur",
          "ost",
          "osti",
          "osts",
          "rjómi",
          "rjóma",
          "smjör",
          "smjöri",
          "mysa",
          "mysuprótein"
        ],
        "compoundDeclarations": [
          "mjólkurofnæmi",
          "mjólkurpróteinofnæmi"
        ]
      },
      "egg": {
        "forms": [
          "egg",
          "eggin",
          "eggjum",
          "eggjunum",
          "eggja",
          "eggjanna",
          "eggjalaus",
          "eggjalaust",
          "eggjalausa",
          "eggjalausar"
        ],
        "foods": [
          "eggjahvíta",
          "eggjahvítu",
          "eggjahvítur",
          "eggjarauða",
          "eggjarauðu",
          "eggjarauður"
        ],
        "compoundDeclarations": [
          "eggjaofnæmi"
        ]
      },
      "fish": {
        "forms": [
          "fiskur",
          "fisk",
          "fiski",
          "fisks",
          "fiskinn",
          "fiskinum",
          "fiskar",
          "fiska",
          "fiskum",
          "fisklaus",
          "fisklaust"
        ],
        "foods": [
          "lax",
          "laxi",
          "laxinn",
          "laxinum",
          "þorskur",
          "þorsk",
          "þorski",
          "þorsks",
          "ýsa",
          "ýsu",
          "ufsi",
          "ufsa",
          "lúða",
          "lúðu",
          "túnfiskur",
          "túnfisk",
          "túnfiski",
          "makríll",
          "makríl",
          "makríl",
          "síld",
          "síldar"
        ],
        "compoundDeclarations": [
          "fiskofnæmi"
        ]
      },
      "shellfish": {
        "forms": [
          "skelfiskur",
          "skelfisk",
          "skelfiski",
          "skelfisks",
          "krabbadýr",
          "krabbadýrum",
          "lindýr",
          "lindýrum"
        ],
        "foods": [
          "rækja",
          "rækjur",
          "rækjum",
          "rækju",
          "kræklingur",
          "krækling",
          "kræklingi",
          "krabbi",
          "krabba",
          "humar",
          "humri",
          "smokkfiskur",
          "smokkfisk",
          "smokkfiski"
        ],
        "compoundDeclarations": [
          "skelfiskofnæmi",
          "rækjuofnæmi"
        ]
      },
      "peanuts": {
        "forms": [
          "jarðhneta",
          "jarðhnetu",
          "jarðhnetur",
          "jarðhnetum",
          "jarðhnetna",
          "jarðhnetusmjör",
          "jarðhnetusmjöri",
          "hnetusmjör",
          "hnetusmjöri",
          "hnetusmjörs",
          "hnetusmjörssósa",
          "hnetusmjörssósu",
          "jarðhnetusmjörssósa",
          "jarðhnetusmjörssósu"
        ],
        "compoundDeclarations": [
          "jarðhnetuofnæmi"
        ]
      },
      "tree_nuts": {
        "forms": [
          "trjáhnetur",
          "trjáhnetum",
          "trjáhnetna",
          "trjáhnetu",
          "möndla",
          "möndlu",
          "möndlur",
          "möndlum",
          "valhneta",
          "valhnetu",
          "valhnetur",
          "valhnetum",
          "heslihneta",
          "heslihnetu",
          "heslihnetur",
          "heslihnetum",
          "kasjúhneta",
          "kasjúhnetu",
          "kasjúhnetur",
          "kasjúhnetum",
          "kasjú",
          "pekanhneta",
          "pekanhnetur",
          "pekanhnetum",
          "pistasíuhneta",
          "pistasíuhnetur",
          "pistasíuhnetum",
          "makadamíuhneta",
          "makadamíuhnetur",
          "brasilíuhneta",
          "brasilíuhnetur"
        ],
        "compoundDeclarations": [
          "trjáhnetuofnæmi",
          "möndluofnæmi"
        ]
      },
      "wheat": {
        "forms": [
          "hveiti",
          "hveitis",
          "hveitinu",
          "hveitilaus",
          "hveitilaust",
          "hveitilausar",
          "spelt",
          "spelti"
        ],
        "compoundDeclarations": [
          "hveitiofnæmi"
        ]
      },
      "gluten": {
        "forms": [
          "glúten",
          "glúteni",
          "glútens",
          "glútenið",
          "glútenlaust",
          "glútenlaus",
          "glútenlausa",
          "glútenlausar"
        ],
        "foods": [
          "rúgur",
          "rúg",
          "rúgi",
          "bygg",
          "byggi"
        ],
        "compoundDeclarations": [
          "glútenóþol",
          "selíak",
          "selíaksjúkdómur"
        ]
      },
      "soy": {
        "forms": [
          "soja",
          "sojabaun",
          "sojabaunir",
          "sojabaunum",
          "sojamjólk",
          "sojaprótein",
          "sojalaust",
          "sojalaus",
          "sojalausar"
        ],
        "foods": [
          "tófú",
          "tofu",
          "tempeh",
          "sojasósa",
          "sojasósu"
        ],
        "compoundDeclarations": [
          "sojaofnæmi"
        ]
      },
      "sesame": {
        "forms": [
          "sesam",
          "sesamfræ",
          "sesamfræjum",
          "sesamfræja",
          "sesamolía",
          "sesamolíu"
        ],
        "foods": [
          "tahini"
        ],
        "compoundDeclarations": [
          "sesamofnæmi"
        ]
      },
      "mustard": {
        "forms": [
          "sinnep",
          "sinnepi",
          "sinneps",
          "sinnepsfræ",
          "sinnepsfræjum"
        ],
        "compoundDeclarations": [
          "sinnepsofnæmi"
        ]
      },
      "celery": {
        "forms": [
          "sellerí",
          "sellerís",
          "sellerírót",
          "sellerírótinni",
          "sellerírótar"
        ],
        "compoundDeclarations": [
          "selleríofnæmi"
        ]
      }
    },
    "ambiguous": {
      "nuts": {
        "forms": [
          "hneta",
          "hnetu",
          "hnetur",
          "hnetum",
          "hnetna",
          "hnetulaus",
          "hnetulaust",
          "hnetulausa",
          "hnetulausar",
          "hnetuofnæmi"
        ],
        "exclude": [
          "tree_nuts",
          "peanuts"
        ]
      },
      "seafood": {
        "forms": [
          "sjávarfang",
          "sjávarfangi",
          "sjávarfangs"
        ],
        "exclude": [
          "fish",
          "shellfish"
        ]
      },
      "lactose": {
        "forms": [
          "laktósi",
          "laktósa",
          "laktósi",
          "laktósalaus",
          "laktósalaust",
          "mjólkursykur",
          "mjólkursykri",
          "mjólkursykurs",
          "laktósaóþol",
          "mjólkursykursóþol"
        ]
      }
    },
    "notFoodMatches": [
      "eggaldin",
      "eggaldini",
      "eggjandi",
      "smjörbaunir",
      "smjörbaunum",
      "kókos",
      "kókosmjólk",
      "kókosolía",
      "kjúklingabaunir",
      "sunnudagssteik",
      "laugardagsnammi"
    ]
  },
  "protein_groups_and_common_foods": {
    "proteinGroups": {
      "chicken": [
        "kjúklingur",
        "kjúkling",
        "kjúklingi",
        "kjúklings",
        "kjúklingabringa",
        "kjúklingabringu",
        "kjúklingabringur",
        "kjúklingalæri"
      ],
      "turkey": [
        "kalkúnn",
        "kalkún",
        "kalkúni",
        "kalkúns"
      ],
      "beef": [
        "nautakjöt",
        "nautakjöti",
        "nautakjöts",
        "nautahakk",
        "nautahakki",
        "nautasteik",
        "nautasteikur"
      ],
      "pork": [
        "svínakjöt",
        "svínakjöti",
        "svínakjöts",
        "svín",
        "svíni",
        "beikon",
        "beikoni",
        "skinka",
        "skinku",
        "svínahakk"
      ],
      "lamb": [
        "lambakjöt",
        "lambakjöti",
        "lambakjöts",
        "lambalæri",
        "lambahakk"
      ],
      "white_fish": [
        "hvítur fiskur",
        "hvítan fisk",
        "hvítum fiski",
        "þorskur",
        "þorsk",
        "þorski",
        "ýsa",
        "ýsu",
        "ufsi",
        "ufsa"
      ],
      "oily_fish": [
        "feitur fiskur",
        "feitan fisk",
        "feitum fiski",
        "lax",
        "laxi",
        "makríll",
        "makríl",
        "síld"
      ],
      "tuna": [
        "túnfiskur",
        "túnfisk",
        "túnfiski",
        "túnfisks"
      ],
      "prawns": [
        "rækja",
        "rækjur",
        "rækjum",
        "rækju"
      ],
      "shellfish": [
        "skelfiskur",
        "skelfisk",
        "skelfiski",
        "kræklingur",
        "krækling",
        "kræklingi",
        "humar",
        "humri"
      ],
      "eggs": [
        "egg",
        "eggjum",
        "eggja",
        "eggjahvíta",
        "eggjahvítu",
        "eggjarauða",
        "eggjarauðu"
      ],
      "dairy": [
        "mjólkurvörur",
        "mjólkurvörum",
        "mjólkurvara",
        "mjólk",
        "skyr",
        "skyri",
        "jógúrt",
        "osti",
        "ostur",
        "ost",
        "kotasæla",
        "kotasælu"
      ],
      "tofu_tempeh": [
        "tófú",
        "tofu",
        "tempeh"
      ],
      "beans_lentils": [
        "baunir",
        "baunum",
        "bauna",
        "linsubaunir",
        "linsubaunum",
        "linsubauna",
        "nýrnabaunir",
        "nýrnabaunum",
        "svartar baunir",
        "svörtum baunum",
        "smjörbaunir",
        "smjörbaunum"
      ],
      "chickpeas": [
        "kjúklingabaunir",
        "kjúklingabaunum",
        "kjúklingabauna"
      ],
      "whey": [
        "mysuprótein",
        "mysupróteini",
        "mysupróteins",
        "mysa",
        "mysu"
      ],
      "plant_protein": [
        "jurtaprótein",
        "jurtapróteini",
        "plöntuprótein",
        "plöntupróteini",
        "ertuprótein",
        "ertuprotein",
        "ertupróteini"
      ]
    },
    "broadGroups": {
      "meat": {
        "forms": [
          "kjöt",
          "kjöti",
          "kjöts",
          "kjötið",
          "kjötinu",
          "kjötlaust",
          "kjötlaus",
          "kjötlausar"
        ],
        "groups": [
          "chicken",
          "turkey",
          "beef",
          "pork",
          "lamb"
        ]
      },
      "red_meat": {
        "forms": [
          "rautt kjöt",
          "rauðu kjöti",
          "rauðs kjöts"
        ],
        "groups": [
          "beef",
          "pork",
          "lamb"
        ]
      },
      "poultry": {
        "forms": [
          "alifuglar",
          "alifugla",
          "alifuglum",
          "alifuglakjöt",
          "alifuglakjöti"
        ],
        "groups": [
          "chicken",
          "turkey"
        ]
      }
    },
    "ingredientTerms": {
      "pancake": [
        "pönnukaka",
        "pönnuköku",
        "pönnukökur",
        "pönnukökum"
      ],
      "blueberry": [
        "bláber",
        "bláberjum",
        "bláberja"
      ],
      "raspberry": [
        "hindber",
        "hindberjum",
        "hindberja"
      ],
      "strawberry": [
        "jarðarber",
        "jarðarberjum",
        "jarðarberja"
      ],
      "banana": [
        "banani",
        "banana",
        "bananar",
        "banönum",
        "bananann"
      ],
      "oats": [
        "hafrar",
        "hafra",
        "höfrum",
        "haframjöl",
        "haframjöli",
        "hafragrautur",
        "hafragraut"
      ],
      "rice": [
        "hrísgrjón",
        "hrísgrjónum",
        "hrísgrjóna"
      ],
      "mushroom": [
        "sveppur",
        "svepp",
        "sveppir",
        "sveppi",
        "sveppum",
        "sveppa"
      ],
      "onion": [
        "laukur",
        "lauk",
        "lauknum",
        "laukinn",
        "laukum"
      ],
      "garlic": [
        "hvítlaukur",
        "hvítlauk",
        "hvítlauknum",
        "hvítlauks"
      ],
      "tomato": [
        "tómatur",
        "tómat",
        "tómatar",
        "tómata",
        "tómötum"
      ],
      "pepper": [
        "paprika",
        "papriku",
        "paprikur",
        "paprikum"
      ],
      "avocado": [
        "avókadó",
        "avokadó"
      ],
      "spinach": [
        "spínat",
        "spínati",
        "spínats"
      ],
      "potato": [
        "kartafla",
        "kartöflu",
        "kartöflur",
        "kartöflum"
      ],
      "sweet_potato": [
        "sæt kartafla",
        "sæta kartöflu",
        "sætar kartöflur",
        "sætum kartöflum",
        "sætkartafla",
        "sætkartöflur",
        "sætkartöflum"
      ],
      "broccoli": [
        "spergilkál",
        "spergilkáli",
        "brokkolí"
      ],
      "bread": [
        "brauð",
        "brauði",
        "brauðs"
      ],
      "pasta": [
        "pasta",
        "pastanu"
      ],
      "peanut_butter": [
        "hnetusmjör",
        "hnetusmjöri",
        "hnetusmjörs",
        "jarðhnetusmjör",
        "jarðhnetusmjöri",
        "hnetusmjörssósa",
        "hnetusmjörssósu",
        "jarðhnetusmjörssósa",
        "jarðhnetusmjörssósu"
      ],
      "butter": [
        "smjör",
        "smjöri",
        "smjörs"
      ],
      "coconut": [
        "kókos",
        "kókosmjöli",
        "kókosmjöl",
        "kókosmjólk"
      ],
      "eggplant": [
        "eggaldin",
        "eggaldini",
        "eggaldins",
        "eggaldinið"
      ],
      "sunday_roast": [
        "sunnudagssteik",
        "sunnudagssteikina"
      ],
      "saturday_candy": [
        "laugardagsnammi",
        "laugardagsnammið"
      ]
    }
  }
} as const;

export type IsVocab = typeof IS_VOCAB;
