/**
 * Every user-facing string on the site, in one place, so a second language (Icelandic) can be added as
 * src/content/is.ts with the same shape. Claims here were checked against docs/USER_GUIDE.md,
 * BUILD_STATUS.md and the app source; see website/README.md "Fact sources" before changing one.
 * House rules: sentence case, no em dashes, few exclamation marks, no guilt or body talk.
 */
export const en = {
  lang: 'en',
  meta: {
    title: 'Hard Earned · Workout and weight tracker',
    description:
      'Track your workouts, follow a plan that fits your week and see your progress. Works offline and installs to your home screen.',
    ogAlt: 'Hard Earned. Your work, made visible.',
  },
  skip: 'Skip to content',
  nav: {
    label: 'Main',
    home: 'Hard Earned home',
    links: [
      { href: '#logging', label: 'Logging' },
      { href: '#plan', label: 'Plan' },
      { href: '#progress', label: 'Progress' },
      { href: '#nutrition', label: 'Nutrition' },
      { href: '#install', label: 'Install' },
      { href: '#faq', label: 'FAQ' },
    ],
    cta: 'Start tracking',
  },

  hero: {
    badge: 'Workout and weight tracker',
    title: 'Your work, made visible.',
    lede: 'Track your workouts, follow a plan that fits your week and see your progress. One session at a time.',
    primary: 'Start tracking',
    secondary: 'See how it works',
    note: 'Opens in your browser. No store needed.',
    shotAlt: 'Hard Earned today screen: the next session, Full body A, with a Start workout button and this week’s completed sessions.',
    demo: {
      label: 'Demo',
      caption: 'Animated demo of logging a set. Not your data.',
      exercise: 'Barbell back squat',
      meta: '3 × 6–8 · 2 reps in reserve · rest 2:30',
      colSet: 'Set',
      colKg: 'kg',
      colReps: 'Reps',
      done: 'Done',
      rest: 'Rest',
      next: 'Next: set 3 · 102,5 kg × 8',
      pause: 'Pause demo',
      play: 'Play demo',
      replay: 'Replay',
      sr: 'Demo: set 2 of barbell back squat, 102.5 kilograms for 8 reps, marked done. The rest timer starts at 2 minutes 30 seconds.',
    },
  },

  ticker: ['Every set adds up', 'Built by showing up', 'Your work, made visible'],

  logging: {
    kicker: '01 / Warm-up',
    title: 'Log a set in one tap.',
    lede: 'Type the weight and reps, tap the tick. It saves as you type, on your phone, even with no signal.',
    rows: [
      { k: 'Offline', v: 'Every set saves on your device first. Losing signal or closing the app never loses a workout.' },
      { k: 'Rest timer', v: 'Starts after each set. Plus or minus 15 seconds, pause or skip. Clock based, so it stays right when the phone locks.' },
      { k: 'Supersets', v: 'Pair an exercise with the next one from the exercise menu.' },
      { k: 'Warm-ups', v: 'Always lighter than your working weight, and never counted toward records or volume.' },
      { k: 'Swaps', v: 'Alternatives that fit your equipment and anything you want to go easy on.' },
      { k: 'Set types', v: 'Drop sets, timed sets, RPE or reps in reserve, copy previous.' },
    ],
    stat: { value: '4 × 8', label: 'Values carry into the next set' },
    sticker: 'Saves offline',
    shotAlt: 'Hard Earned active workout screen: barbell back squat with warm-up and working sets, a progression tip and the rest timer at 2:30.',
  },

  plan: {
    kicker: '02 / Working sets',
    title: 'A plan that fits your week.',
    lede: 'Answer a short setup: goal, experience, days, session length, where you train and what equipment you have. You get a program built from that, with the reason it fits.',
    builder: {
      legend: 'How many days a week can you lift?',
      days: 'days',
      /**
       * Mirrors the strength-goal table in src/domain/program/splits.ts (first entry = recommended) with labels
       * and session names from src/domain/program/templates.ts. Update both if the app's catalog changes.
       */
      splits: {
        2: [
          { name: 'Full-body A/B', why: 'Each muscle group twice a week, and missing a session still leaves a complete workout.', sessions: ['Full body A', 'Full body B'] },
          { name: 'Upper / Lower', why: 'More work per muscle in each session, but each muscle group is trained once a week.', sessions: ['Upper A', 'Lower A'] },
        ],
        3: [
          { name: 'Full-body A/B/C', why: 'Main lifts practised three times a week with shorter sessions. The easiest to recover from.', sessions: ['Full body A', 'Full body B', 'Full body C'] },
          { name: 'Upper / Lower / Full body', why: 'An upper, a lower and a full-body day. More work per session, upper and lower body each trained twice.', sessions: ['Upper A', 'Lower A', 'Full body'] },
          { name: 'Push / Pull / Legs', why: 'Most work per muscle in each session, but each muscle group is trained once a week and a missed day skips a whole area.', sessions: ['Push A', 'Pull A', 'Legs A'] },
        ],
        4: [
          { name: 'Upper / Lower ×2', why: 'Each muscle group twice a week with focused sessions and a recovery day for each half.', sessions: ['Upper A', 'Lower A', 'Upper B', 'Lower B'] },
          { name: 'Full-body ×4', why: 'Four shorter full-body sessions. Frequent practice of every lift; handy when sessions are short.', sessions: ['Full body A', 'Full body B', 'Full body C', 'Full body D'] },
        ],
        5: [
          { name: 'Upper / Lower + Push / Pull / Legs', why: 'Upper/lower plus push, pull and legs. High frequency and volume.', sessions: ['Upper A', 'Lower A', 'Push A', 'Pull A', 'Legs B'] },
          { name: 'Upper / Lower ×2 + Full body', why: 'Upper/lower twice plus a full-body day. Twice-weekly frequency with less specialised days.', sessions: ['Upper A', 'Lower A', 'Upper B', 'Lower B', 'Full body'] },
        ],
        6: [
          { name: 'Push / Pull / Legs ×2', why: 'Push, pull and legs twice each. High volume; needs good sleep and recovery.', sessions: ['Push A', 'Pull A', 'Legs A', 'Push B', 'Pull B', 'Legs B'] },
          { name: 'Upper / Lower ×3', why: 'Upper and lower three times each. High frequency with moderate work per session.', sessions: ['Upper A', 'Lower A', 'Upper B', 'Lower B', 'Upper C', 'Lower C'] },
        ],
      },
      suggested: 'Suggested split',
      also: 'Also on offer',
      week: 'Your sessions',
      note: 'Split names and trade-offs as shown in the app for a strength goal. You can change split or shuffle exercises anytime.',
    },
    points: [
      { k: 'Progression', v: 'After a session the app suggests adding weight, holding or adding reps. Choose Apply, Keep previous or Customize.' },
      { k: 'Your equipment', v: 'Only the kit you said you have, on the days you picked.' },
      { k: 'Your own routine', v: 'Already have a program? Build your sessions yourself.' },
    ],
    tip: { label: 'Add reps', value: '50 kg × 11 reps', options: ['Apply', 'Keep previous', 'Customize'] },
  },

  progress: {
    kicker: '03 / Top set',
    title: 'See what you’ve built.',
    lede: 'Charts and records come straight from what you logged. Observations are plain facts, not grades.',
    stats: [
      { value: '102,5', unit: 'kg', label: 'Top set, charted per exercise' },
      { value: 'e1RM', unit: '', label: 'Estimated one-rep max, clearly labelled as an estimate' },
      { value: '7-day', unit: '', label: 'Body weight average, described neutrally' },
    ],
    list: ['Consistency against your plan', 'Working sets per muscle each week', 'Volume, with the calculation shown', 'Records for supported exercises', 'Cardio time, distance and pace', 'Measurements and goals you set'],
    shotAlt: 'Hard Earned progress screen: this week’s observations and a sessions-per-week chart.',
    shotAlt2: 'Hard Earned today screen in the light theme.',
  },

  nutrition: {
    kicker: '04 / Refuel',
    title: 'Protein first. Simple food.',
    lede: 'Turn nutrition on if you want it. Start with protein only, or add calories and macros. Every number shows how it was worked out.',
    recipeCount: '275',
    recipeLabel: 'recipes with step-by-step prep guides',
    points: [
      { k: 'Protein target', v: '1.8 g per kg of a reference weight you choose. An adjustable starting point, not a rule.' },
      { k: 'Meal plans', v: 'A week built from your preferences and allergies, balanced toward your protein target, with a shopping list.' },
      { k: 'Quick meals', v: 'Filter for 15 minutes or less. Scale servings and swap ingredients.' },
    ],
    chips: {
      legend: 'Which proteins do you like?',
      hint: 'Tap once to like, twice for not for me. Like in the app.',
      items: ['Chicken', 'Fish', 'Eggs', 'Tofu', 'Beef', 'Beans', 'Dairy', 'Lamb'],
      states: { none: 'No preference', like: 'Liked', no: 'Not for me' },
      footer: 'Liked proteins show up more. Not for me never shows up. Allergies stay a separate safety filter.',
    },
    shotAlt: 'Hard Earned nutrition screen: protein target of 148 g and today’s meals.',
    shotAlt2: 'Hard Earned recipe prep guide in the light theme: servings, macros per serving and an ingredient checklist.',
  },

  assistant: {
    kicker: '05 / Spotter',
    title: 'A training assistant that knows your plan.',
    lede: 'Ask about your training, recovery or food. It answers from your own records and offers changes you review and apply yourself.',
    exampleLabel: 'Example conversation',
    aiLabel: 'AI',
    you: 'You',
    name: 'Training assistant',
    chat: [
      { from: 'you', text: 'I can only train twice this week.' },
      { from: 'ai', text: 'No problem. You’ve done Full body A already, so do **Full body B on Thursday** and skip Saturday. Your normal schedule comes back next week.' },
      { from: 'action', text: 'Apply to this week' },
      { from: 'you', text: 'Make me a meal plan for the weekend.' },
      { from: 'ai', text: 'Here’s Saturday and Sunday at your **148 g** protein target, with the proteins you like.' },
    ],
    mealCard: {
      title: 'Meal plan · Sat and Sun',
      rows: [
        { day: 'Sat', meals: 'Skyr berry bowl with oats · Chicken fajitas with skyr · Lemon baked cod with potatoes & peas', protein: '151 g' },
        { day: 'Sun', meals: 'Skyr & oat pancakes · Lemony tuna & pea pasta · Beef & black bean chilli with rice', protein: '149 g' },
      ],
      action: 'Add to my meal plan',
      secondary: 'Customize first',
    },
    stylesTitle: 'Pick a coach style',
    styles: [
      { name: 'Supportive', text: 'Gentle and encouraging. Never pushes.' },
      { name: 'Balanced', text: 'The default. Encouraging, with light accountability.' },
      { name: 'Strict', text: 'Tough love on excuses. Rest is still rest.' },
    ],
    disclaimer: 'AI. Suggestions, not medical advice.',
    fine: 'Needs an account. You choose what it can see and agree before anything is sent to the AI provider, which the app names. Pain, illness or poor sleep always mean rest or an easier plan.',
  },

  coaches: {
    kicker: '06 / Coach',
    title: 'Want a human in your corner?',
    find: {
      kicker: 'For lifters',
      title: 'Find a coach',
      text: 'Search by town, region or country, or use your location. Filter for in person or online, specialty and language. You decide what a coach can see.',
    },
    apply: {
      kicker: 'For coaches',
      title: 'Apply to be listed',
      text: 'Coaches send an application from inside the app and follow its review status. Clients, plans and messages live in one workspace.',
    },
    fine: 'Listed coaches are approved by Hard Earned’s reviewers. Approval isn’t a verified qualification unless the listing says so. Needs an account.',
  },

  friends: {
    kicker: '07 / Training partners',
    title: 'Share what you choose. Nothing more.',
    lede: 'After a workout, pick the details to share and who sees them. Friends never see your full history.',
    preview: {
      legend: 'Share this workout',
      fields: ['Duration', 'Exercise names', 'Weights and reps', 'Volume', 'Records'],
      audience: 'Audience',
      friends: 'Friends',
      onlyMe: 'Only me',
      postTitle: 'Full body A',
      postBy: 'You · just now',
      sample: { Duration: '52 min', 'Exercise names': 'Squat · Bench press · Row', 'Weights and reps': 'Squat 102,5 kg × 8', Volume: '6 240 kg', Records: 'New record: squat' },
      visibleTo: 'Visible to',
      hidden: 'Nothing selected yet.',
      demoNote: 'Interactive preview. Nothing is posted.',
    },
    points: ['Auto-share is off by default', 'Photos lose their location data before upload', 'Remove, block or report anyone, anytime'],
  },

  privacy: {
    kicker: '08 / Your data',
    title: 'Your records stay yours.',
    lede: 'Hard Earned stores your training on your device first. An account is optional and only adds sync, friends and coaching.',
    items: [
      { k: 'Local first', v: 'Use it without an account. Workouts, plans, nutrition and progress all work on your device.' },
      { k: 'Export anytime', v: 'Download a full backup as JSON, or CSV files for workouts, activities and measurements.' },
      { k: 'Delete anytime', v: 'Deleting your account removes everything from the server and the device.' },
      { k: 'You choose', v: 'Coaches and the training assistant only see the categories you share. Change it whenever you like.' },
    ],
    note: 'No ads or trackers on this website. No cookies either.',
  },

  install: {
    kicker: '09 / Cool-down',
    title: 'It’s an app. No store needed.',
    lede: 'Hard Earned runs in your browser and installs to your home screen. It opens full screen and works offline after the first load.',
    tabsLabel: 'Choose your device',
    platforms: [
      {
        id: 'iphone',
        name: 'iPhone and iPad',
        steps: ['Open the app in Safari.', 'Tap the Share button.', 'Choose Add to Home Screen, keep Open as Web App on, then tap Add.', 'Open Hard Earned from your Home Screen.'],
        note: 'Needed for notifications on iPhone and iPad: they only work in the installed app.',
      },
      {
        id: 'android',
        name: 'Android',
        steps: ['Open the app in Chrome.', 'Tap the menu (⋮).', 'Choose Install app, or Add to Home screen.', 'Launch it from the new icon.'],
        note: 'Some browsers also show an Install button in Settings, under Install on your phone.',
      },
      {
        id: 'desktop',
        name: 'Desktop',
        steps: ['Open the app in Chrome or Edge.', 'Click the install icon at the end of the address bar.', 'Choose Install.', 'Open it from your apps like any other.'],
        note: 'Or just keep it in a browser tab. Everything works the same.',
      },
    ],
    shotAlt: 'Hard Earned install screen with steps for adding the app to a phone.',
    updates: 'New version ready? You’ll see Update available. It never reloads in the middle of a workout.',
  },

  faq: {
    kicker: 'Questions',
    title: 'Good questions.',
    items: [
      { q: 'Does it work offline?', a: 'Yes. After the first load, logging, plans, nutrition and progress work without signal. Everything saves on your device first. With an account, it syncs when you’re back online.' },
      { q: 'Do I need an account?', a: 'No. You can train without one and keep everything on your device. An account adds sync between devices, friends, human coaching and the training assistant.' },
      { q: 'Where is my data stored?', a: 'On your device. If you create an account, your records also sync to the Hard Earned server so they’re on your other devices. Download a full backup or delete everything whenever you like.' },
      { q: 'Is the training assistant AI?', a: 'Yes, and it’s labelled as AI everywhere. It gives suggestions, not medical advice. You agree before anything is sent to the AI provider, choose what it can see, and apply every change yourself.' },
      { q: 'How do human coaches work?', a: 'Search the directory for a coach near you or online and send a request. You choose what they can see. Plan changes from a coach only happen when you accept them. Coaches can apply to be listed from inside the app.' },
      { q: 'Kilograms or pounds?', a: 'Either. Switch in Settings and your logged values stay exact. A decimal comma works when you type.' },
      { q: 'Which devices does it run on?', a: 'Any recent phone, tablet or computer with a modern browser. Install it to your home screen on iPhone, iPad and Android, or as an app on desktop Chrome and Edge.' },
      { q: 'Can I get notifications?', a: 'Yes, with an account: workout reminders, rest-over alerts and coaching messages, each with its own switch. On iPhone and iPad, install the app to your Home Screen first.' },
      { q: 'Which languages?', a: 'English for now.' },
      { q: 'Can I bring my own program?', a: 'Yes. Choose I already have a program during setup and build your sessions yourself.' },
    ],
  },

  cta: {
    title: 'Put your progress on record.',
    text: 'Start with today’s workout. Keep building.',
    button: 'Start tracking',
  },

  footer: {
    line: 'Every set adds up.',
    nav: 'Footer',
    links: { start: 'Start tracking', install: 'Install', privacy: 'Privacy', contact: 'Contact' },
    small: 'Screens show the app’s demo data, a sample dataset, not a real person.',
  },
} as const;

export type Content = typeof en;
