# Office artwork

`office-room.png` is an original 1536×1024 background generated for agent-harness
on 2026-09-12 with OpenAI's image tool. Its brief describes a top-down 16-bit RPG
office with four desks, a boardroom and a lounge, warm wooden floors, teal walls,
plants and daylight. It contains no people, text, logos or UI.

The user's sample images and office asset directory informed the visual direction.
No commercial asset pack was downloaded or incorporated. No characters or artwork
from Octopath Traveler or Final Fantasy were copied.

Characters are original 32×40 SVG pixel designs in `office-sprites.ts`; their pose,
clothing, hair and accessories are rendered separately from the backdrop. Seated
characters reach forward with two alternating hand poses over the desk keyboard
already in the room image. Arms render behind the head; a low blue chair back
occludes only the lower torso. No extra keyboard is drawn across the body. Pip the cat (40×24) and Orbit the
hovering companion (40×34) are original decorative SVGs in the same module; the
cat's tail uses two held frames and Orbit uses a small stepped vertical bob. All character
names and appearances are cosmetic display identities. Activity comes from harness
status records, not from the image. Coordinate anchors are normalized to the
background; no remote art request is needed while viewing the office.

Orbit also opens state-derived dashboard guidance. Its hover remains cosmetic;
the interaction does not create an agent, send messages or make model calls.
Floor zoom and the expanded view scale the existing artwork without regenerating it.
