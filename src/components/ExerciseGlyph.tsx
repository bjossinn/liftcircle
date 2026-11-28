import type { ReactNode } from 'react';
import clsx from 'clsx';
import type { MovementPattern } from '@/domain/types';
import { ICON_STROKE } from '@/components/Icon';
import { type GlyphKey, patternGlyphKey } from '@/data/exerciseGlyphs';

/**
 * Direction B exercise pictograms: one 24×24 line figure per glyph key (src/data/exerciseGlyphs.ts), drawn for a 24 px
 * mark inside a 44 px tile (stroke 1.75, round caps and joins, `currentColor`; only heads and a few small loads are
 * filled; 0.35-opacity strokes for floors, cables and other secondary lines). Side views face right.
 * Used in every exercise list, the picker and the compact logger row (ExerciseThumb), large on the exercise detail
 * header, and per movement pattern for program-session marks and custom exercises. The full start/end illustrations
 * (full.webp) stay on the detail page and the expanded logger row. Contact sheet: docs/exercise-glyphs.html.
 */
const Ground = () => <path d="M2.5 21.2h19" strokeOpacity={0.35} />;
const Head = ({ cx, cy }: { cx: number; cy: number }) => <circle cx={cx} cy={cy} r={1.7} fill="currentColor" stroke="none" />;
/** Secondary line (floor, cable, band path, hidden limb). */
const Faint = ({ d, dashed }: { d: string; dashed?: boolean }) => (
  <path d={d} strokeOpacity={0.35} strokeDasharray={dashed ? '1.5 2' : undefined} />
);

export const GLYPHS: Record<GlyphKey, ReactNode> = {
  /* ------------------------------------------------------------------ squat / lunge */
  // Back squat, front view: bar across the shoulders, knees out.
  barbell_squat: (
    <>
      <Head cx={12} cy={4.6} />
      <path d="M3.6 8.1h16.8M3.6 6.6v3M20.4 6.6v3" />
      <path d="M12 8.1v4" />
      <path d="M12 12.1 8 15.3l.6 5.2M12 12.1l4 3.2-.6 5.2" />
      <Ground />
    </>
  ),
  // Front / goblet squat, side view: load held at the chest, elbows down.
  front_squat: (
    <>
      <Head cx={11.9} cy={5.3} />
      <path d="M11.2 7.5 9 14.6" />
      <path d="M9 14.6l5.4 1.2-1.4 4.8h2.4" />
      <path d="M11 8.6l2.2 3.6 1.6-2.2" />
      <rect x={14.2} y={8.3} width={2.6} height={2.6} rx={0.9} fill="currentColor" />
      <Ground />
    </>
  ),
  // Leg press: reclined on a backrest, feet pressing a diagonal platform.
  leg_press: (
    <>
      <path d="M2.8 11.2 7 18.6h4.6" />
      <Head cx={4.8} cy={7.6} />
      <path d="M6 9.6 9 16l4.6-3.4 3.4-3.8" />
      <path d="M15.2 6.6l4.4 4.4" />
    </>
  ),
  // Hack squat: back on an angled sled, shoulder pads, feet on the plate.
  hack_squat: (
    <>
      <Faint d="M2.6 4.4 8 20.4" />
      <Head cx={6.2} cy={5.6} />
      <path d="M6.9 7.6 9.4 14.4" />
      <path d="M5.6 8.2h3.6" />
      <path d="M9.4 14.4l4.6-1.6-.6 6.8" />
      <path d="M11.6 20.6l4.4-1" />
      <Ground />
    </>
  ),
  // Bodyweight squat, side view: hips back, arms reaching forward.
  bodyweight_squat: (
    <>
      <Head cx={11.2} cy={5.6} />
      <path d="M10.6 7.7 8.4 14.6" />
      <path d="M8.4 14.6l5.4 1.4-1.6 4.6h2.6" />
      <path d="M10.4 8.8h7" />
      <Ground />
    </>
  ),
  // Bulgarian split squat: rear foot on a bench.
  rear_foot_split_squat: (
    <>
      <path d="M2.2 14.6h5.4M3.4 14.6v6.6M6.4 14.6v6.6" strokeOpacity={0.6} />
      <Head cx={11.6} cy={3.8} />
      <path d="M11.6 5.8v7" />
      <path d="M11.6 12.8l4.2.6.4 6.8h2" />
      <path d="M11.6 12.8 9.4 18.6l-3.4-4" />
      <path d="M11.6 7.2l.8 5" />
      <Ground />
    </>
  ),
  // Split-stance lunge, side view.
  lunge: (
    <>
      <Head cx={11} cy={4.2} />
      <path d="M11 6.2v6.3" />
      <path d="M11 7.8l1.4 4" />
      <path d="M11 12.5l5 .8.4 7.2" />
      <path d="M11 12.5l-2.6 7.2-3.9.4" />
      <Ground />
    </>
  ),
  // Step-up: one foot planted on a box, the trailing foot below.
  step_up: (
    <>
      <path d="M12.6 21.2v-5h8v5" />
      <Head cx={10.4} cy={2.8} />
      <path d="M10.2 4.8 9.8 11" />
      <path d="M9.8 11l4.6.4.2 4.8" />
      <path d="M9.8 11l-.6 4.8-1.8 5" />
      <path d="M10.2 6.2l.6 4.4" />
      <Ground />
    </>
  ),
  // Half-kneeling hip flexor stretch: rear knee down, hips forward, upright torso.
  kneeling_hip_stretch: (
    <>
      <Head cx={10.2} cy={4.4} />
      <path d="M10.4 6.4 11 13" />
      <path d="M11 13l4.6.2.2 7h2.2" />
      <path d="M11 13l-2.6 7.2H3.6" />
      <path d="M10.6 8 13.4 10.6 15.4 12.8" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ hinge */
  // Conventional deadlift, start: hips low, knees bent, arms straight to the bar.
  deadlift: (
    <>
      <Head cx={15.8} cy={8.2} />
      <path d="M13.8 9 6.4 12.4" />
      <path d="M6.4 12.4l4.8 2.8-.8 5.4h2" />
      <path d="M13.8 9.4v7" />
      <circle cx={14} cy={18.8} r={2.4} />
      <circle cx={14} cy={18.8} r={0.7} fill="currentColor" stroke="none" />
      <Ground />
    </>
  ),
  // Romanian deadlift: hips back, soft knees, arms hanging toward the shins.
  rdl: (
    <>
      <Head cx={15.6} cy={6.8} />
      <path d="M13.8 7.8 6.4 11.4" />
      <path d="M6.4 11.4l3 4.4-.6 4.8h2.4" />
      <path d="M12.8 8.4l-.2 8.2" />
      <Ground />
    </>
  ),
  // Single-leg RDL: torso and free leg in one long line.
  single_leg_rdl: (
    <>
      <Head cx={19.2} cy={10.2} />
      <path d="M17.2 10.8H10.4" />
      <path d="M10.4 10.8 2.6 9.8" />
      <path d="M10.4 10.8l.8 4.8-.6 5h2.4" />
      <path d="M16.2 11v6" />
      <Ground />
    </>
  ),
  // Barbell hip thrust: shoulders on a bench, bar across raised hips.
  hip_thrust: (
    <>
      <path d="M1.8 15.6h5.4M4.6 15.6v5.6" strokeOpacity={0.6} />
      <Head cx={3.6} cy={12.4} />
      <path d="M5.6 13.6 12.4 12.6h4.8v8h2" />
      <circle cx={12.6} cy={9.8} r={2} />
      <Ground />
    </>
  ),
  // Glute bridge: shoulders on the floor, hips lifted, feet planted.
  glute_bridge: (
    <>
      <Head cx={3.4} cy={18.8} />
      <path d="M5.4 19.8 12.2 14.8l4.6-1.4.6 7.2h2" />
      <path d="M6 20.4h5" />
      <Ground />
    </>
  ),
  // Single-leg bridge: one foot planted, the other leg extended.
  single_leg_bridge: (
    <>
      <Head cx={3.4} cy={18.8} />
      <path d="M5.4 19.8 12.2 14.8l4.6 .2.6 5.6h2" />
      <path d="M12.2 14.8l8.4-5" />
      <Ground />
    </>
  ),
  // Kettlebell swing: arms straight at chest height, bell out in front.
  kettlebell_swing: (
    <>
      <Head cx={9.6} cy={4.4} />
      <path d="M9.8 6.4 9.2 13" />
      <path d="M9.2 13l.8 3.8-.4 3.8h2.4" />
      <path d="M9.6 7.6l7.2 1.4" />
      <path d="M15.6 10.8V9h2.4v1.8" />
      <circle cx={16.8} cy={12.6} r={1.9} fill="currentColor" stroke="none" />
      <Ground />
    </>
  ),
  // Back extension: hips on a 45° pad, feet anchored, body extended in one line.
  back_extension: (
    <>
      <Head cx={18.6} cy={5.6} />
      <path d="M16.8 7 4.4 17.2" />
      <path d="M10.8 14.6l2.2 1.8M12 15.6v5.6M5.6 19.6 4 18.2M3.6 21.2h10" strokeOpacity={0.6} />
    </>
  ),
  // Cable pull-through: hinged, facing away from a low anchor, cable between the legs.
  pull_through: (
    <>
      <Faint d="M2.4 13v8.2" />
      <Faint d="M2.4 18 10.8 16.4" dashed />
      <Head cx={15.6} cy={7} />
      <path d="M13.8 8 7.6 11.6" />
      <path d="M7.6 11.6l2.4 4.2-.6 4.8h2.4" />
      <path d="M13 8.6l-2.2 7.8" />
      <Ground />
    </>
  ),
  // Slider leg curl: supine bridge, heels on sliding discs.
  slider_leg_curl: (
    <>
      <Head cx={3.4} cy={18.8} />
      <path d="M5.4 19.8 11.4 16.8l4.6-.6 3.6 3" />
      <path d="M6 20.4h4.4" />
      <path d="M17.6 21.2a2.2 1.4 0 0 1 4.4 0z" fill="currentColor" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ horizontal / vertical push */
  // Bench press, side view: on a flat bench, arm pressed up.
  bench_press: (
    <>
      <path d="M2.8 16.2h13.4M5 16.2v4.3M14 16.2v4.3" strokeOpacity={0.6} />
      <Head cx={5} cy={13.3} />
      <path d="M6.7 14h8" />
      <path d="M14.7 14l3.3-2.6 1.4 9.1" />
      <path d="M8.6 14V7.2" />
      <path d="M7.2 7.2h2.8" />
    </>
  ),
  // Incline press: on a ~35° backrest, arm pressed up.
  incline_press: (
    <>
      <path d="M3 13 10.8 18h3.6M10.8 18v3.2" strokeOpacity={0.6} />
      <Head cx={3.8} cy={9.4} />
      <path d="M5.4 10.8 11.4 15.2" />
      <path d="M11.4 15.2l4.6-.6.8 6h2" />
      <path d="M7 12V5" />
      <path d="M5.6 5h2.8" />
    </>
  ),
  // Push-up: straight body, hands and toes on the floor, elbows bending.
  push_up: (
    <>
      <Head cx={18.4} cy={13.6} />
      <path d="M16.4 14.8 3 20.4" />
      <path d="M16 15l-1.8 3 2.4 2.6" />
      <Ground />
    </>
  ),
  // Incline push-up: hands on a box, feet on the ground.
  incline_push_up: (
    <>
      <path d="M14.8 21.2v-6.6h6v6.6" strokeOpacity={0.6} />
      <Head cx={17.4} cy={9} />
      <path d="M15.6 10.4 3 20.4" />
      <path d="M15.2 10.8l1.6 3.8" />
      <Ground />
    </>
  ),
  // Machine chest press: upright on a seat, pressing forward at chest height.
  seated_chest_press: (
    <>
      <path d="M5 6.6v10.8h7M8.4 17.4v3.8" strokeOpacity={0.6} />
      <Head cx={7.6} cy={5.6} />
      <path d="M7.6 7.6v8.4" />
      <path d="M7.6 16h5l.6 4.6" />
      <path d="M7.6 9.2h7.6" />
      <path d="M15.6 7.6v3.2" />
    </>
  ),
  // Standing cable fly, front view: arms hugging forward, cables from high and wide.
  standing_fly: (
    <>
      <Faint d="M2.6 3 7.8 12.2M21.4 3l-5.2 9.2" dashed />
      <Head cx={12} cy={4.4} />
      <path d="M12 6.4v7" />
      <path d="M9.6 8.2h4.8" />
      <path d="M9.6 8.2C6 8.6 5.6 11.4 8 12.4M14.4 8.2c3.6.4 4 3.2 1.6 4.2" />
      <path d="M12 13.4 10.4 20.6M12 13.4l1.6 7.2" />
      <Ground />
    </>
  ),
  // Dumbbell fly, end-on view: lying on a bench, arms opened wide, dumbbells at the ends.
  lying_fly: (
    <>
      <path d="M7.6 17.6h8.8M12 17.6v3.6" strokeOpacity={0.6} />
      <Head cx={12} cy={13.6} />
      <path d="M4.2 12.4 8.2 15.8h7.6l4-3.4" />
      <circle cx={3.4} cy={11.6} r={1.3} fill="currentColor" stroke="none" />
      <circle cx={20.6} cy={11.6} r={1.3} fill="currentColor" stroke="none" />
    </>
  ),
  // Floor press: lying on the floor, knees bent, dumbbell pressed straight up.
  floor_press: (
    <>
      <Head cx={3.4} cy={18.8} />
      <path d="M5.4 19.8h7l3-5.4 3.2 6.2" />
      <path d="M7.4 19.8v-8" />
      <path d="M6 11.8h2.8" />
      <Ground />
    </>
  ),
  // Band chest press: staggered stance, pressing forward, band anchored behind.
  standing_chest_press: (
    <>
      <Faint d="M2.4 6v6" />
      <Faint d="M2.4 9.6 8.4 9" dashed />
      <Head cx={11.8} cy={4.2} />
      <path d="M11.4 6.2 10.2 13" />
      <path d="M10.2 13l2.6 3.4.2 4.2h2.2" />
      <path d="M10.2 13 6 20.6" />
      <path d="M11.2 7.8h7.4" />
      <Ground />
    </>
  ),
  // Dip, side view: hands on the parallel bar, elbows bent back, feet off the floor.
  dip: (
    <>
      <path d="M4.6 13.4h3.6M6.4 13.4v7.8M15.8 13.4h3.6M17.6 13.4v7.8" strokeOpacity={0.6} />
      <Head cx={12} cy={6.6} />
      <path d="M9.6 9.2h4.8" />
      <path d="M9.6 9.2 6.6 10.2l-.2 3.2M14.4 9.2l3 1 .2 3.2" />
      <path d="M12 9.2v6" />
      <path d="M12 15.2l-1.4 4.8M12 15.2l1.4 4.8" />
      <Ground />
    </>
  ),
  // Standing overhead press, front view: both arms pressed overhead, no bar.
  standing_overhead_press: (
    <>
      <Head cx={12} cy={6.4} />
      <path d="M9.4 9h5.2M9.4 9 8.6 2.6M14.6 9l.8-6.4" />
      <path d="M12 9v5.6" />
      <path d="M12 14.6l-1.8 6M12 14.6l1.8 6" />
      <Ground />
    </>
  ),
  // Seated overhead press, front view: sitting on a bench, arms pressed overhead.
  seated_overhead_press: (
    <>
      <path d="M6.4 15.2h11.2" strokeOpacity={0.6} />
      <Head cx={12} cy={6.4} />
      <path d="M9.4 9h5.2M9.4 9 8.6 2.6M14.6 9l.8-6.4" />
      <path d="M12 9v5" />
      <path d="M9.4 14h5.2M9.4 14v6.6H8M14.6 14v6.6H16" />
      <Ground />
    </>
  ),
  // Pike push-up: inverted V, hips high, head between the hands.
  pike_push_up: (
    <>
      <Head cx={16} cy={17.6} />
      <path d="M10.6 9.6 15 15.6" />
      <path d="M14.6 15.2l2.6 5.4" />
      <path d="M10.6 9.6 5 20.6" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ pulls */
  // Bent-over row: hinged, elbow pulled back, hand at the lower ribs.
  bent_over_row: (
    <>
      <Head cx={15.8} cy={7.8} />
      <path d="M13.8 8.6 5.8 11.6" />
      <path d="M5.8 11.6l2.8 4.2-.6 4.8h2.4" />
      <path d="M13.2 9 8.8 6.2l.6 4.6" />
      <Ground />
    </>
  ),
  // One-arm dumbbell row: one hand on a bench, the other rowing a dumbbell.
  supported_one_arm_row: (
    <>
      <path d="M4.6 15.4h15M6 15.4v5.8M18.2 15.4v5.8" strokeOpacity={0.6} />
      <Head cx={18.4} cy={8.4} />
      <path d="M16.4 9.4H8.6" />
      <path d="M8.6 9.4l.4 4.4H5" />
      <path d="M16.2 9.6l.2 4.4" />
      <path d="M15.4 9.4 11.4 5.8l.4 5.2" />
      <circle cx={11.8} cy={12} r={1.1} fill="currentColor" stroke="none" />
      <Ground />
    </>
  ),
  // Seated row: upright, legs forward to a footplate, handle pulled to the abdomen.
  seated_row: (
    <>
      <path d="M2.6 19.6h6.4" strokeOpacity={0.6} />
      <Head cx={7} cy={7.6} />
      <path d="M7 9.6v8.8" />
      <path d="M7 18.4l5-1.8 4.6 1.6" />
      <path d="M17.8 15.2v5.4" />
      <path d="M7 11 4.6 13.4h4.6" />
      <Faint d="M9.6 13.4h10.8" dashed />
    </>
  ),
  // Chest-supported row: chest on an incline pad, elbow pulling back.
  chest_supported_row: (
    <>
      <path d="M6 17.8 15.6 12.8M11 15.4v5.8" strokeOpacity={0.6} />
      <Head cx={16.2} cy={9.8} />
      <path d="M14.2 10.8 6.6 14.8" />
      <path d="M6.6 14.8l-3 5.8" />
      <path d="M13.4 11.2 10 7.8l.8 4.6" />
      <Ground />
    </>
  ),
  // Inverted row: body straight under a bar, heels on the floor, chest pulled up.
  inverted_row: (
    <>
      <path d="M10.6 8.4h8.8M19.4 8.4v12.8" strokeOpacity={0.6} />
      <Head cx={16.4} cy={12.4} />
      <path d="M14.6 13.8 3 20.4" />
      <path d="M13.6 14.2 11.6 11l2-2.6" />
      <Ground />
    </>
  ),
  // Standing row: leaning back slightly, handles pulled to the ribs from a forward anchor.
  standing_row: (
    <>
      <Faint d="M21 6.6v6" />
      <Faint d="M10.4 10.6H21" dashed />
      <Head cx={8.4} cy={4.4} />
      <path d="M8.6 6.4 9.6 13" />
      <path d="M9.6 13l1.4 3.6-.4 4h2.2M9.6 13l-1 7.6" />
      <path d="M8.8 7.8 6.4 10.4l3.8.2" />
      <Ground />
    </>
  ),
  // Pull-up, front view: hanging from the bar, elbows bent, chin toward the bar.
  pull_up: (
    <>
      <path d="M3 3h18" />
      <path d="M7.2 3 6.2 7.6l3.4 1.6M16.8 3l1 4.6-3.4 1.6" />
      <Head cx={12} cy={6.4} />
      <path d="M9.6 9.2h4.8" />
      <path d="M12 9.2v5.6" />
      <path d="M12 14.8l-1.4 5.6M12 14.8l1.4 5.6" />
    </>
  ),
  // Lat pulldown, front view: seated, wide handle pulled down from an overhead cable.
  lat_pulldown: (
    <>
      <Faint d="M12 1.2v3.2" />
      <path d="M4.6 4.6h14.8" />
      <path d="M6.4 4.6 6.6 9.8l3 1.2M17.6 4.6l-.2 5.2-3 1.2" />
      <Head cx={12} cy={8.6} />
      <path d="M9.6 11h4.8" />
      <path d="M12 11v5" />
      <path d="M7 17h10" strokeOpacity={0.6} />
      <path d="M9.6 16.2v4.6M14.4 16.2v4.6" />
      <Ground />
    </>
  ),
  // Prone floor pulldown, side view: lying face down on the floor, chest up, elbow pulled back (the W seen from the side).
  prone_pulldown: (
    <>
      <Head cx={18} cy={15.8} />
      <path d="M16 17.4 9.6 19.8H2.6" />
      <path d="M15.4 17.8 11.8 15.4l2.8-3.2" />
      <Ground />
    </>
  ),
  // Straight-arm pulldown: slight hinge, straight arms pulled down from a high anchor.
  straight_arm_pulldown: (
    <>
      <Faint d="M20.6 2.4 14.6 12.2" dashed />
      <Head cx={11.8} cy={4.8} />
      <path d="M11 6.6 9.2 13" />
      <path d="M9.2 13l1.2 3.6-.4 4h2.2M9.2 13l-1.2 7.6" />
      <path d="M10.6 7.6l3.8 4.8" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ shoulders and arms */
  // Lateral raise, front view: arms out to the sides at shoulder height.
  lateral_raise: (
    <>
      <Head cx={12} cy={4.4} />
      <path d="M3.4 8.2 9.6 7.6h4.8l6.2.6" />
      <path d="M3.4 6.8v2.8M20.6 6.8v2.8" />
      <path d="M12 7.6v6" />
      <path d="M12 13.6l-1.8 7M12 13.6l1.8 7" />
      <Ground />
    </>
  ),
  // Face pull, front view: elbows high and wide, hands pulled up beside the face.
  face_pull: (
    <>
      <Head cx={12} cy={6.4} />
      <path d="M9.4 9h5.2" />
      <path d="M9.4 9 4.8 7.4 7.8 3.8M14.6 9l4.6-1.6-3-3.6" />
      <path d="M12 9v5.6" />
      <path d="M12 14.6l-1.8 6M12 14.6l1.8 6" />
      <Ground />
    </>
  ),
  // Band pull-apart, front view: arms out at chest height, band stretched between the hands.
  pull_apart: (
    <>
      <Head cx={12} cy={4.4} />
      <path d="M9.6 7.6h4.8M9.6 7.6l-6 2.4M14.4 7.6l6 2.4" />
      <path d="M3.6 10.2h16.8" strokeOpacity={0.6} />
      <path d="M12 7.6v6" />
      <path d="M12 13.6l-1.8 7M12 13.6l1.8 7" />
      <Ground />
    </>
  ),
  // Rear delt fly, front view of a hinged lifter: head down, arms opened wide like wings.
  rear_delt_fly: (
    <>
      <Head cx={12} cy={11.6} />
      <path d="M8.8 9.2h6.4" />
      <path d="M8.8 9.2 3 7.2M15.2 9.2l5.8-2" />
      <path d="M10.6 10.6l-1.4 4.6.6 5.4M13.4 10.6l1.4 4.6-.6 5.4" />
      <Ground />
    </>
  ),
  // Curl, side view: upper arm still, forearm curled up.
  curl: (
    <>
      <Head cx={9.5} cy={4} />
      <path d="M9.5 6v7.6" />
      <path d="M9.5 7.4l.6 4.8 4-3.4" />
      <path d="M14.6 7.4v3" />
      <path d="M9.5 13.6l-1.5 6.9M9.5 13.6l1.5 6.9" />
      <Ground />
    </>
  ),
  // Triceps pushdown: elbows pinned, hands pushed down from a high cable.
  triceps_pushdown: (
    <>
      <Faint d="M14.6 1.6 13 13" dashed />
      <Head cx={9.8} cy={4.2} />
      <path d="M10 6.2 9.4 13.6" />
      <path d="M9.4 13.6l-1.4 7M9.4 13.6l1.4 7" />
      <path d="M9.8 7.4 9.4 11.4l3.4 2.6" />
      <Ground />
    </>
  ),
  // Overhead triceps extension, front view: elbows up beside the head, hands behind it.
  overhead_triceps_extension: (
    <>
      <Head cx={12} cy={8} />
      <path d="M9.4 10.6h5.2" />
      <path d="M9.4 10.6 8.8 3.6l2.2 2.6M14.6 10.6l.6-7-2.2 2.6" />
      <path d="M10.6 6.2h2.8M10.6 5v2.4M13.4 5v2.4" />
      <path d="M12 10.6v4.6" />
      <path d="M12 15.2l-1.8 5.4M12 15.2l1.8 5.4" />
      <Ground />
    </>
  ),
  // Skull crusher: lying on a bench, upper arm up, forearm folded toward the forehead.
  lying_triceps_extension: (
    <>
      <path d="M2.8 16.2h13.4M5 16.2v4.3M14 16.2v4.3" strokeOpacity={0.6} />
      <Head cx={5} cy={13.3} />
      <path d="M6.7 14h8" />
      <path d="M14.7 14l3.3-2.6 1.4 9.1" />
      <path d="M8.6 14 8 7.4 5.2 10.4" />
    </>
  ),

  /* ------------------------------------------------------------------ leg isolation */
  // Leg extension, seated on a machine, shin pushing the ankle roller up.
  leg_extension: (
    <>
      <Head cx={6.8} cy={4.8} />
      <path d="M6.6 6.8 6 13" />
      <path d="M6 13h6l5.6-2.2" />
      <circle cx={18.8} cy={10.4} r={1.2} />
      <path d="M6.5 8.4l2 3.6" />
      <path d="M3.5 14.6h9M8 14.6v5.9M5 20.5h6" strokeOpacity={0.6} />
    </>
  ),
  // Lying leg curl: face down on a bench, heels curled up under the roller.
  lying_leg_curl: (
    <>
      <path d="M3 15.4h15.6M5 15.4v5.8M16.6 15.4v5.8" strokeOpacity={0.6} />
      <Head cx={19} cy={12.2} />
      <path d="M17 13.6H5.4l2-5.6" />
      <circle cx={6.8} cy={6.4} r={1.2} />
    </>
  ),
  // Seated leg curl: thigh under a pad, shin pulled back under the seat.
  seated_leg_curl: (
    <>
      <Head cx={6.6} cy={4.6} />
      <path d="M6.6 6.6v7.6" />
      <path d="M6.6 14.2h6l-2.6 5" />
      <circle cx={8.8} cy={20} r={1.2} />
      <path d="M10.2 12.4h4.2" />
      <path d="M3.6 15.8h10.2" strokeOpacity={0.6} />
      <path d="M6.6 8 9.4 12" />
    </>
  ),
  // Standing calf raise: on the balls of the feet on a step, heels up.
  standing_calf_raise: (
    <>
      <rect x={13} y={18.2} width={7} height={3} rx={0.6} fill="currentColor" stroke="none" />
      <Head cx={11.4} cy={3} />
      <path d="M11.4 5v10.6" />
      <path d="M10.4 15.6l3.6 2.6" />
      <path d="M11.4 6.4l1.2 4.4" />
      <Ground />
    </>
  ),
  // Seated calf raise: knees bent under a pad, heels lifted off a block.
  seated_calf_raise: (
    <>
      <path d="M2.8 14.6h6" strokeOpacity={0.6} />
      <rect x={14.2} y={18.4} width={6} height={2.8} rx={0.6} fill="currentColor" stroke="none" />
      <Head cx={6.2} cy={4.8} />
      <path d="M6.2 6.8v6.4h6.6v3.4" />
      <path d="M11.8 16.6l3.6 1.8" />
      <path d="M10.4 11.2h4.6" />
      <path d="M6.2 8.4l3.6 2.8" />
      <Ground />
    </>
  ),
  // Band lateral walk, front view: wide half squat, band around the shins, stepping sideways.
  band_lateral_walk: (
    <>
      <Head cx={12.6} cy={4.6} />
      <path d="M12.4 6.6 12 12.6" />
      <path d="M12 12.6 8 15.6l-2.6 5M12 12.6l3.4 3.6.8 4.4" />
      <path d="M6.4 18.6h9.6" strokeOpacity={0.6} />
      <path d="M12.2 8.2 9.6 11.6M12.2 8.2l2.8 3.2" />
      <Ground />
    </>
  ),
  // Side-lying hip abduction: lying on one side, top leg raised.
  side_lying_abduction: (
    <>
      <Head cx={3.8} cy={15.8} />
      <path d="M5.6 17.2 11.6 18.6" />
      <path d="M11.6 18.6l9 1.8M11.6 18.6l8.2-7" />
      <path d="M5.6 17.6 5 20.6" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ trunk */
  // Forearm plank, side view.
  plank: (
    <>
      <Head cx={4.6} cy={12.9} />
      <path d="M6.5 14.6l14 4.9" />
      <path d="M6.5 14.6V20h3.8" />
      <Ground />
    </>
  ),
  // Side plank: diagonal body on one forearm, top arm pointing up.
  side_plank: (
    <>
      <Head cx={4.6} cy={11.6} />
      <path d="M6.6 13 20.6 20.4" />
      <path d="M6.8 13.2V20.4h3" />
      <path d="M7 12.6V5" />
      <Ground />
    </>
  ),
  // Dead bug: on the back, one arm up, opposite leg extended, other knee bent over the hip.
  dead_bug: (
    <>
      <Head cx={3.6} cy={18.8} />
      <path d="M5.6 19.8h6.6" />
      <path d="M12.2 19.8l.4-6h4.6" />
      <path d="M12.2 19.8l8.4-2.2" />
      <path d="M7 19.6l.4-7.4" />
      <path d="M6.2 19.2 3 13.2" />
      <Ground />
    </>
  ),
  // Bird dog: on hands and knees, one arm reaching forward, the opposite leg back.
  bird_dog: (
    <>
      <Head cx={17} cy={11.2} />
      <path d="M15 13.6H8.2" />
      <path d="M15 13.6v7h1.4" />
      <path d="M15.2 13.6 21.4 13" />
      <path d="M8.2 13.6v7H4.6" />
      <path d="M8.2 13.6 1.8 12.4" />
      <Ground />
    </>
  ),
  // Reverse crunch: on the back, knees tucked to the chest, hips curled up.
  reverse_crunch: (
    <>
      <Head cx={3.6} cy={18.8} />
      <path d="M5.6 19.8 11.4 18.4" />
      <path d="M11.4 18.4 9 12.6l4.6-1.2" />
      <path d="M6.2 20.4h6.8" />
      <Ground />
    </>
  ),
  // Hanging knee raise: hanging from a bar, knees raised to hip height.
  hanging_knee_raise: (
    <>
      <path d="M4 2.6h16" />
      <path d="M11 2.6v6" />
      <Head cx={13.4} cy={6.4} />
      <path d="M11.6 8.6v6" />
      <path d="M11.6 14.6l5-.2.2 5" />
    </>
  ),
  // Pallof press, front view: hands pressed out from the chest, cable pulling from the side.
  pallof_press: (
    <>
      <Faint d="M2.4 6.2v7" />
      <Faint d="M2.4 9.6 10.8 10.6" dashed />
      <Head cx={12} cy={4.4} />
      <path d="M9.6 7.4h4.8M9.6 7.4l2.4 3.2 2.4-3.2" />
      <path d="M12 7.4v6.2" />
      <path d="M12 13.6l-2.4 7M12 13.6l2.4 7" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ carries */
  // Farmer's carry: a dumbbell in each hand.
  farmer_carry: (
    <>
      <Head cx={12} cy={4} />
      <path d="M12 5.9V13" />
      <path d="M9.5 7.5h5M9.5 7.5 7 12.4M14.5 7.5l2.5 4.9" />
      <path d="M7 12.4v4.4M5.8 12.4h2.4M5.8 16.8h2.4M17 12.4v4.4M15.8 12.4h2.4M15.8 16.8h2.4" />
      <path d="M12 13l-2 7.5M12 13l2 7.5" />
      <Ground />
    </>
  ),
  // Suitcase carry: one dumbbell on one side, torso upright.
  suitcase_carry: (
    <>
      <Head cx={12} cy={4} />
      <path d="M12 5.9V13" />
      <path d="M9.5 7.5h5M9.5 7.5 7 12.4M14.5 7.5l1.6 5.2" />
      <path d="M7 12.4v4.4M5.8 12.4h2.4M5.8 16.8h2.4" />
      <path d="M12 13l-2 7.5M12 13l2 7.5" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ conditioning */
  // Rowing machine: seat on a long rail, legs bent to the footplate, handle at the torso.
  rowing_erg: (
    <>
      <path d="M2.4 19.6h14.6M3.6 19.6v1.6" strokeOpacity={0.6} />
      <circle cx={19.2} cy={17.4} r={2.2} strokeOpacity={0.6} />
      <Head cx={4.8} cy={8.6} />
      <path d="M5.6 10.6 7.4 17.6" />
      <path d="M7.4 17.6l4.6-5 4.4 5" />
      <path d="M6 12l3.2 2.8" />
      <Faint d="M9.4 14.8 17.2 16.6" />
    </>
  ),
  // Stationary bike: seated, hands on the bars, one flywheel.
  stationary_bike: (
    <>
      <circle cx={17.4} cy={17.6} r={2.8} strokeOpacity={0.6} />
      <path d="M8.4 12.2 10.6 17.6h4M15.8 15.2 15 8.4h2.4M6.6 11.8h3.4M5 21.2h15" strokeOpacity={0.6} />
      <Head cx={12.6} cy={3.6} />
      <path d="M11.4 5.4 8.4 10.8" />
      <path d="M11 6.6 14.6 8.2" />
      <path d="M8.4 10.8l4.4 1.8-1.6 4.6" />
    </>
  ),
  // Incline treadmill walk: striding on a raised deck, console in front.
  treadmill_walk: (
    <>
      <path d="M2.6 20.6 18.4 17.8M18.4 17.8 19.8 8.4l-2.4 .4" strokeOpacity={0.6} />
      <Head cx={10.4} cy={3.6} />
      <path d="M10.2 5.6 9.8 12.4" />
      <path d="M9.8 12.4l2 3.4 1.2 3M9.8 12.4l-1.6 3.6-1.8 3.8" />
      <path d="M10.2 7l2.4 3.6M10.2 7l-2 3.4" />
    </>
  ),
  // Mountain climber: high plank, one knee driven forward under the torso.
  mountain_climber: (
    <>
      <Head cx={18} cy={11.4} />
      <path d="M16 12.6 9.4 16" />
      <path d="M15.8 12.8l.4 7.8" />
      <path d="M9.4 16 2.6 20.2" />
      <path d="M9.4 16l4 2.2-2.8 2.2" />
      <Ground />
    </>
  ),
  // Burpee: low crouch, palms on the floor, knees tucked under the torso.
  burpee: (
    <>
      <Head cx={16.2} cy={10.6} />
      <path d="M14.4 11.8 8 14.4" />
      <path d="M14.2 12.2l1.4 8.4" />
      <path d="M8 14.4l4.2 2.2-3 4h-2" />
      <Ground />
    </>
  ),
  // Jumping jack, front view: legs apart, arms up in a star, feet off the floor.
  jumping_jack: (
    <>
      <Head cx={12} cy={6.2} />
      <path d="M9.6 8.8h4.8M9.6 8.8 5 3M14.4 8.8 19 3" />
      <path d="M12 8.8v5.4" />
      <path d="M12 14.2l-5 5.4M12 14.2l5 5.4" />
      <Ground />
    </>
  ),
  // Heart-rate pulse (fallback for custom conditioning exercises).
  conditioning_pulse: (
    <>
      <path d="M2.5 13.5h4l2.2-5.5 3.3 10 2.6-7.5 1.6 3h5.3" />
      <path d="M4 20h16" strokeOpacity={0.35} />
    </>
  ),

  /* ------------------------------------------------------------------ mobility */
  // World's greatest stretch: deep lunge, one hand down, the other arm reaching up.
  lunge_rotation: (
    <>
      <Head cx={15.2} cy={8.8} />
      <path d="M13.8 10.4 9.8 15.4" />
      <path d="M9.8 15.4l5.4.4.4 4.8h2.2" />
      <path d="M9.8 15.4 2.8 19.8" />
      <path d="M13.6 10.8l.6 9.8" />
      <path d="M13.8 10.4 13.4 3" />
      <Ground />
    </>
  ),
  // Cat-cow (cat phase): on hands and knees, back rounded, head tucked.
  cat_cow: (
    <>
      <Head cx={17.4} cy={16.4} />
      <path d="M8.2 14C9.6 8.6 14 8.6 15.4 13.6" />
      <path d="M15.4 13.6v7" />
      <path d="M8.2 14v6.4H4.8" />
      <Ground />
    </>
  ),
  // Thoracic rotation: on hands and knees, upper body turned open, top arm reaching up.
  thoracic_rotation: (
    <>
      <Head cx={16.8} cy={11.4} />
      <path d="M15 13.6H8.2" />
      <path d="M15 13.6v7" />
      <path d="M14.6 13.4 13.4 4.6" />
      <path d="M8.2 13.6v6.8H4.8" />
      <Ground />
    </>
  ),
  // Band shoulder pass-through, front view: band held wide overhead on straight arms.
  shoulder_pass_through: (
    <>
      <path d="M3.6 3.2h16.8" strokeOpacity={0.6} />
      <Head cx={12} cy={6.8} />
      <path d="M9.6 9.4h4.8M9.6 9.4 4.2 3.4M14.4 9.4l5.4-6" />
      <path d="M12 9.4v5.4" />
      <path d="M12 14.8l-1.6 5.8M12 14.8l1.6 5.8" />
      <Ground />
    </>
  ),
  // Seated forward fold (fallback for custom mobility exercises).
  seated_forward_fold: (
    <>
      <Head cx={13.4} cy={12.4} />
      <path d="M5.4 19.4 11.6 14.4" />
      <path d="M11.4 15l7.5 2.6" />
      <path d="M5.4 19.4h14M19.4 19.4v-2.6" />
      <Ground />
    </>
  ),

  /* ------------------------------------------------------------------ neutral */
  // Neutral fallback: a plain dumbbell.
  neutral: (
    <>
      <path d="M7.4 12h9.2" />
      <rect x={4.6} y={8.4} width={2.8} height={7.2} rx={1} />
      <rect x={16.6} y={8.4} width={2.8} height={7.2} rx={1} />
      <path d="M3 10.4v3.2M21 10.4v3.2" />
    </>
  ),
};

type GlyphSource = { glyph: GlyphKey; pattern?: MovementPattern } | { glyph?: undefined; pattern: MovementPattern };

/** One 24×24 exercise pictogram, by glyph key (preferred) or by movement pattern. */
export function ExerciseGlyph({ glyph, pattern, className }: GlyphSource & { className?: string }) {
  const key: GlyphKey = glyph && glyph in GLYPHS ? glyph : patternGlyphKey(pattern);
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-glyph={key}
      data-pattern={pattern}
      className={className ?? 'size-6'}
    >
      {GLYPHS[key]}
    </svg>
  );
}

/** Glyph in a Direction B tile (`bg-surface-2 text-accent rounded-xl`): md = 44 px tile / 24 px mark; lg = detail header. */
export function ExerciseGlyphTile({
  size = 'md',
  className,
  ...source
}: GlyphSource & { size?: 'md' | 'lg'; className?: string }) {
  return (
    <span
      data-testid="exercise-glyph-tile"
      className={clsx(
        'inline-flex shrink-0 items-center justify-center bg-surface-2 text-accent',
        size === 'lg' ? 'size-20 rounded-2xl' : 'size-11 rounded-xl',
        className,
      )}
    >
      <ExerciseGlyph {...source} className={size === 'lg' ? 'size-11' : 'size-6'} />
    </span>
  );
}
