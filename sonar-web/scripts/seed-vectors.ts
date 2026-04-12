#!/usr/bin/env tsx
// Pre-seed the RedisVL vector index with real artists as anchor points.
// Run from sonar-web/:  npx tsx scripts/seed-vectors.ts
//
// Rate limits:
//   Voyage AI free tier (no payment method) = 3 RPM → ~22s between calls
//   Voyage AI paid tier                     = 300 RPM → no meaningful delay
//
// Set SEED_DELAY_MS in .env.local to override (default: 5000ms, safe for paid tier)

import { config } from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
config({ path: resolve(__dirname, '../.env.local') })
import { storeArtistVector, ensureArtistIndex } from '../lib/vectorstore'
import { getClient } from '../lib/redis'
import type { ArtistCard } from '../lib/agent'

const DELAY_MS = parseInt(process.env.SEED_DELAY_MS ?? '0')
const KEY_PREFIX = 'sonar:artist:'

// ─── Seed data ────────────────────────────────────────────────────────────────
// Each entry is a real artist with hand-crafted qualitative descriptions.
// Quantitative fields (listeners, buzzScore) reflect approximate values at time of writing.
// The fullBrief is the text that gets embedded — make it rich.

const SEED_ARTISTS: ArtistCard[] = [
  // ── R&B / Soul anchors ───────────────────────────────────────────────────
  {
    id: 'seed-sza',
    name: 'SZA',
    genre: ['R&B', 'neo soul', 'indie R&B'],
    location: 'Maplewood, NJ',
    monthlyListeners: 52000000,
    buzzScore: 97,
    summary: 'SZA is the defining voice of modern R&B — emotionally raw, sonically expansive, and consistently ahead of the mainstream curve.',
    fullBrief: 'Sound Profile: Lush, confessional R&B built on acoustic guitar, layered vocals, and production that blurs indie, soul, and pop. Lyrical themes centre on romantic vulnerability, self-worth, and the complexity of modern womanhood. Comparable to Erykah Badu\'s introspection but with a contemporary indie-pop gloss. Her sound sits between the intimacy of bedroom pop and the polish of major label R&B. Key aesthetic: imperfection as beauty — raw vocal takes left in, ambient noise kept, emotional truth over technical precision.',
    outreachEmail: '',
    spotifyUrl: 'https://open.spotify.com/artist/3tVQdUvClmAT7URs9V3rsp',
  },
  {
    id: 'seed-frank-ocean',
    name: 'Frank Ocean',
    genre: ['R&B', 'neo soul', 'art pop', 'indie R&B'],
    location: 'New Orleans, LA',
    monthlyListeners: 19000000,
    buzzScore: 95,
    summary: 'Frank Ocean redefined what R&B could be — structurally adventurous, lyrically literary, and emotionally devastating in the best possible way.',
    fullBrief: 'Sound Profile: Avant-garde R&B that deconstructs song structure. Blends lo-fi aesthetics with orchestral ambition. Lyrical themes: queerness, nostalgia, loss, the American experience, and masculinity examined with rare honesty. Production ranges from stripped acoustic to densely layered experimental pop. Blonde is the defining reference point — a record that sounds like memory itself. Comparable to Stevie Wonder\'s emotional scope but filtered through a post-internet, post-genre sensibility. Key aesthetic: silence and space used as compositional tools.',
    outreachEmail: '',
    spotifyUrl: 'https://open.spotify.com/artist/2h93pZq0e7k5yf4dywlkpM',
  },
  {
    id: 'seed-brent-faiyaz',
    name: 'Brent Faiyaz',
    genre: ['R&B', 'alternative R&B', 'PBR&B'],
    location: 'Columbia, MD',
    monthlyListeners: 12000000,
    buzzScore: 88,
    summary: 'Brent Faiyaz occupies the moody, morally complex corner of R&B — unflinching about his flaws, cinematic in his delivery, impossible to ignore.',
    fullBrief: 'Sound Profile: Dark, atmospheric R&B with heavy bass, reverb-drenched vocals, and production that feels like 3am in an empty room. Lyrical themes: infidelity, self-destruction, wealth anxiety, and the loneliness of success. Aesthetic: luxury nihilism. His music sounds expensive and damaged simultaneously. Closest comparable: The Weeknd\'s early mixtape era — same moral ambiguity, similar sonic darkness — but with a rawness The Weeknd eventually polished away. Key signal: every project has grown his audience without compromising his aesthetic.',
    outreachEmail: '',
    spotifyUrl: 'https://open.spotify.com/artist/3Y7RZ31TRPVadSFVy1o8os',
  },
  {
    id: 'seed-daniel-caesar',
    name: 'Daniel Caesar',
    genre: ['R&B', 'soul', 'gospel-influenced R&B'],
    location: 'Toronto, Canada',
    monthlyListeners: 11000000,
    buzzScore: 85,
    summary: 'Daniel Caesar fuses gospel warmth with contemporary R&B vulnerability, producing music that feels both ancient and completely current.',
    fullBrief: 'Sound Profile: Warm, organic R&B rooted in gospel chord progressions, live instrumentation, and vocals that treat melody as a spiritual practice. Lyrical themes: faith, romantic devotion, personal struggle, and healing. Production is deliberately unhurried — songs breathe, space is respected. Key aesthetic: intimacy. His recordings feel like private confessions. Comparable to Sam Cooke\'s emotional directness translated into a modern Toronto context. Strong crossover appeal without compromising his core identity.',
    outreachEmail: '',
  },
  {
    id: 'seed-summer-walker',
    name: 'Summer Walker',
    genre: ['R&B', 'contemporary R&B', 'soul'],
    location: 'Atlanta, GA',
    monthlyListeners: 10000000,
    buzzScore: 84,
    summary: 'Summer Walker brought raw emotional honesty back to mainstream R&B, combining classic soul influences with deeply personal lyricism.',
    fullBrief: 'Sound Profile: Contemporary R&B with heavy classic soul influence — live guitar, warm bass, and production that prioritises emotional texture over sonic perfection. Lyrical themes: toxic relationships, emotional dependency, and the difficulty of self-love. Key aesthetic: vulnerability as strength. Her willingness to document her emotional reality without sanitising it is what separates her from safer contemporaries. Comparable to Mary J. Blige\'s emotional intensity but with a Gen Z directness and social media authenticity.',
    outreachEmail: '',
  },
  {
    id: 'seed-snoh-aalegra',
    name: 'Snoh Aalegra',
    genre: ['R&B', 'neo soul', 'Swedish soul'],
    location: 'Stockholm, Sweden',
    monthlyListeners: 3200000,
    buzzScore: 72,
    summary: 'Snoh Aalegra is the rare artist who makes classic soul feel genuinely modern — emotionally direct, sonically timeless, and entirely her own.',
    fullBrief: 'Sound Profile: Neo-soul with a Scandinavian sensibility — emotionally direct, sonically restrained, and immaculately produced. Heavy Stevie Wonder and Prince influence filtered through contemporary R&B production. Lyrical themes: romantic longing, vulnerability, and the search for genuine connection. No Idea Studios (No I.D.) production context adds prestige and sonic consistency. Key aesthetic: classic without being retro. Comparable to Erykah Badu\'s spiritual quality but with a more conventional song structure. Strong critical acclaim relative to commercial footprint.',
    outreachEmail: '',
  },

  // ── Hip-Hop anchors ──────────────────────────────────────────────────────
  {
    id: 'seed-little-simz',
    name: 'Little Simz',
    genre: ['UK hip-hop', 'rap', 'conscious hip-hop'],
    location: 'London, UK',
    monthlyListeners: 3100000,
    buzzScore: 90,
    summary: 'Little Simz is the most complete MC in the UK — technically dominant, conceptually ambitious, and releasing her best work at the peak of her powers.',
    fullBrief: 'Sound Profile: Dense, orchestral UK hip-hop that prioritises lyricism above all else. Influences draw on grime, jazz, classical composition, and West African music. Lyrical themes: Black British identity, womanhood, north London upbringing, grief, and artistic integrity. Production aesthetic: cinematic and layered — Inflo\'s work with her on Sometimes I Might Be Introvert is a reference point for modern hip-hop production ambition. Comparable to Nas at his peak but with a uniquely British and feminine lens. Mercury Prize winner. Critically the most respected rapper in the UK.',
    outreachEmail: '',
  },
  {
    id: 'seed-noname',
    name: 'Noname',
    genre: ['conscious hip-hop', 'jazz rap', 'spoken word'],
    location: 'Chicago, IL',
    monthlyListeners: 1800000,
    buzzScore: 82,
    summary: 'Noname sits at the intersection of jazz poetry and hip-hop — conversational, politically sharp, and technically precise in a way that rewards close listening.',
    fullBrief: 'Sound Profile: Jazz-influenced hip-hop built on live instrumentation, spoken word cadences, and production that sounds like a Chicago basement session. Lyrical themes: Black liberation politics, Chicago community, anti-capitalism, and literary references. Aesthetic: intellectual without being inaccessible. Her delivery sounds casual while the content is dense. Comparable to Gil Scott-Heron\'s political poetry brought into a contemporary hip-hop framework. Strong cult following with genuine grassroots loyalty — no major label, no industry machinery, entirely self-built audience.',
    outreachEmail: '',
  },
  {
    id: 'seed-jpegmafia',
    name: 'JPEGMAFIA',
    genre: ['experimental hip-hop', 'alternative rap', 'noise rap'],
    location: 'Los Angeles, CA',
    monthlyListeners: 2400000,
    buzzScore: 86,
    summary: 'JPEGMAFIA is the most sonically adventurous rapper working — colliding noise, pop, and hip-hop into something that has no precedent and no peer.',
    fullBrief: 'Sound Profile: Chaotic, maximalist experimental hip-hop. Production pulls from noise music, drill, hyperpop, and film scores simultaneously. Lyrical themes: internet culture, Black masculinity, media criticism, and self-mythology. Aesthetic: aggressive maximalism — everything turned up, every sample unexpected. Comparable to Death Grips\' confrontational energy but with more pop melodic instinct and genuine wit. His self-production is the defining feature — nobody sounds like this because nobody else makes beats like this.',
    outreachEmail: '',
  },
  {
    id: 'seed-saba',
    name: 'Saba',
    genre: ['conscious hip-hop', 'jazz rap', 'Chicago rap'],
    location: 'Chicago, IL',
    monthlyListeners: 2700000,
    buzzScore: 83,
    summary: 'Saba makes deeply personal, structurally ambitious hip-hop that processes grief and identity with a clarity that few artists can match.',
    fullBrief: 'Sound Profile: Introspective hip-hop built on jazz chords, live bass, and vocals that modulate between rapping and singing seamlessly. Lyrical themes: grief, mortality, Chicago gun violence, Black joy, and creative perseverance. CARE FOR ME is a concept album processing his cousin\'s murder — widely considered one of the best hip-hop albums of the 2010s. Comparable to J. Cole\'s emotional directness but without the commercial ambition — Saba is entirely underground-facing. Strong Pitchfork and critical support. His live show is exceptional.',
    outreachEmail: '',
  },

  // ── UK Drill / Grime ──────────────────────────────────────────────────────
  {
    id: 'seed-central-cee',
    name: 'Central Cee',
    genre: ['UK drill', 'rap'],
    location: 'Shepherd\'s Bush, London, UK',
    monthlyListeners: 18000000,
    buzzScore: 93,
    summary: 'Central Cee cracked the global market for UK drill — melodic enough for pop audiences, authentic enough to keep core drill listeners, sharp enough lyrically to command respect.',
    fullBrief: 'Sound Profile: Melodic UK drill with strong pop crossover. Distinctively restrained vocal delivery — conversational almost to the point of monotone — that makes his punchlines land harder. Lyrical themes: London street life, financial ambition, relationship dynamics, and global cultural influence. Key aesthetic: calm confidence over aggression — contrasting with earlier UK drill\'s more confrontational energy. Comparable to Drake\'s ability to float between rap and pop but with a uniquely British street credibility. First UK artist to reach #1 in the US with a debut album. Global trajectory is exceptional.',
    outreachEmail: '',
  },
  {
    id: 'seed-dave',
    name: 'Dave',
    genre: ['UK rap', 'conscious rap', 'grime'],
    location: 'Streatham, London, UK',
    monthlyListeners: 6500000,
    buzzScore: 91,
    summary: 'Dave is the most intellectually rigorous British rapper working — technically elite, thematically ambitious, and producing landmark records at 25.',
    fullBrief: 'Sound Profile: UK rap that sits between grime, conscious hip-hop, and neo-soul. Production on Psychodrama and We\'re All Alone in This Together is orchestral and cinematic. Lyrical themes: institutional racism, Brixton upbringing, mental health, Black British identity, and political injustice. Key aesthetic: thesis-level argumentation through rap — his songs work as essays. BRITS Album of the Year winner. Mercury Prize winner. Comparable to Kendrick Lamar\'s political scope brought into a British context. Widely considered the most important voice in UK rap.',
    outreachEmail: '',
  },
  {
    id: 'seed-digga-d',
    name: 'Digga D',
    genre: ['UK drill', 'rap'],
    location: 'White City, London, UK',
    monthlyListeners: 2900000,
    buzzScore: 79,
    summary: 'Digga D defined a generation of UK drill — raw, specific, and consistent in a scene full of artists who peaked early.',
    fullBrief: 'Sound Profile: Raw, uncompromising UK drill from one of the genre\'s originators. Production is bass-heavy and ominous. Lyrical themes: north-west London street life, legal system, incarceration, loyalty, and the contradictions of success from difficult origins. Key aesthetic: authenticity over aesthetics — no gloss, no compromise. CCTV was a landmark drill album. Comparable to early Fredo or Headie One in terms of scene credibility, but with stronger narrative consistency across projects. His DJBB-era material helped define what drill could be.',
    outreachEmail: '',
  },

  // ── Indie / Alternative anchors ───────────────────────────────────────────
  {
    id: 'seed-phoebe-bridgers',
    name: 'Phoebe Bridgers',
    genre: ['indie folk', 'dream pop', 'chamber pop'],
    location: 'Los Angeles, CA',
    monthlyListeners: 9000000,
    buzzScore: 90,
    summary: 'Phoebe Bridgers makes devastatingly precise indie folk — quiet enough to seem fragile, sharp enough to cut deep, and strange enough to feel like nothing else.',
    fullBrief: 'Sound Profile: Hushed, orchestral indie folk built on fingerpicked acoustic guitar, delicate strings, and vocals that sit just above a whisper. Lyrical themes: grief, failed relationships, climate anxiety, mortality, and the specific sadness of modern American life. Aesthetic: intimate catastrophe — songs that sound like bedtime stories but contain genuine devastation. Comparable to Elliott Smith\'s emotional precision but with a contemporary feminist lens and more collaborative energy (boygenius, Better Oblivion Community Center). Production partner Tony Berg creates arrangements that feel both sparse and lush simultaneously.',
    outreachEmail: '',
  },
  {
    id: 'seed-mitski',
    name: 'Mitski',
    genre: ['indie rock', 'art rock', 'indie pop'],
    location: 'New York, NY',
    monthlyListeners: 9500000,
    buzzScore: 91,
    summary: 'Mitski writes songs about loneliness and desire with the precision of a surgeon and the ferocity of a force of nature — there is nobody quite like her.',
    fullBrief: 'Sound Profile: Emotionally explosive indie rock that can shift from whisper to roar within a single bar. Production ranges from sparse lo-fi bedroom recordings to dense wall-of-sound production. Lyrical themes: isolation, romantic obsession, cultural displacement, female desire, and the exhaustion of performing happiness. Key aesthetic: restraint before release — songs build quietly then erupt. Comparable to PJ Harvey\'s intensity and Kate Bush\'s theatrical ambition filtered through a Japanese-American immigrant experience. Be The Cowboy marked her mainstream breakthrough while retaining cult credibility. TikTok virality (Nobody) brought her a new generation without alienating existing fans.',
    outreachEmail: '',
  },
  {
    id: 'seed-soccer-mommy',
    name: 'Soccer Mommy',
    genre: ['indie rock', 'bedroom pop', 'dream pop'],
    location: 'Nashville, TN',
    monthlyListeners: 2800000,
    buzzScore: 78,
    summary: 'Soccer Mommy makes guitar-driven indie pop that feels like the 90s filtered through a sharper emotional lens — catchy, melancholy, and genuinely her own.',
    fullBrief: 'Sound Profile: Hazy, guitar-led indie pop with 90s alternative influence (Liz Phair, early Alanis Morissette) brought into a contemporary bedroom pop context. Lyrical themes: romantic anxiety, suburban alienation, mental health, and growing up. Production aesthetic: lo-fi warmth over digital polish — guitars slightly fuzzy, drums dry, room sound present. Key comparable: Snail Mail at a similar career stage — emotionally literate, critically beloved, building steadily. Sophie Allison\'s songwriting craft is her defining asset.',
    outreachEmail: '',
  },
  {
    id: 'seed-boygenius',
    name: 'boygenius',
    genre: ['indie folk', 'chamber pop', 'indie rock'],
    location: 'Los Angeles, CA',
    monthlyListeners: 5200000,
    buzzScore: 89,
    summary: 'boygenius — Julien Baker, Phoebe Bridgers, Lucy Dacus — is a supergroup that became more than the sum of its parts, making music no member could alone.',
    fullBrief: 'Sound Profile: Layered, harmonically rich indie folk that benefits from three distinct but compatible voices. Production ranges from intimate acoustic to expansive rock. Lyrical themes: queer identity, friendship as love, loss, and the specific sadness of being a thoughtful person in a difficult world. The Record (2023) is a landmark of indie folk — every song a different mode of the same emotional intelligence. Key aesthetic: harmonies as argument — three perspectives on the same feeling simultaneously. Commercial and critical breakthrough that proves indie folk can reach mainstream audiences without compromise.',
    outreachEmail: '',
  },

  // ── Electronic / Dance ────────────────────────────────────────────────────
  {
    id: 'seed-fred-again',
    name: 'Fred again..',
    genre: ['UK garage', 'electronic', 'dance pop', 'ambient'],
    location: 'London, UK',
    monthlyListeners: 10000000,
    buzzScore: 92,
    summary: 'Fred again.. turned personal voice messages and emotional fragments into dance music — creating a new template for how electronic music can be intimate and euphoric simultaneously.',
    fullBrief: 'Sound Profile: Emotionally intelligent dance music built on pitched-up vocal samples from real conversations, garage rhythms, and production that feels handmade even at club volume. Lyrical content: found audio — text messages, voicemails, ambient conversation — that documents real human moments. Aesthetic: euphoria through intimacy. His live sets at boiler room and Madison Square Garden become communal emotional experiences. Comparable to Jamie xx\'s ability to make melancholy feel like celebration, but with a more confessional and documentary sensibility. Trilogy (Actual Life 1-3) defined a new genre of personal electronic music.',
    outreachEmail: '',
  },
  {
    id: 'seed-kaytranada',
    name: 'Kaytranada',
    genre: ['electronic', 'house', 'R&B', 'funk'],
    location: 'Montreal, Canada',
    monthlyListeners: 4800000,
    buzzScore: 85,
    summary: 'Kaytranada makes dance music that feels like R&B and R&B that feels like dance music — joyful, groove-forward, and technically flawless.',
    fullBrief: 'Sound Profile: Funky, bass-forward electronic music that draws equally from house, R&B, funk, and Caribbean influences. Production is impeccably clean — every element serves the groove. Lyrical content: features from R&B and rap artists whose styles he subtly shapes to fit his production universe. Aesthetic: pure joy expressed through rhythm. 99.9% was a debut album that felt fully formed. Grammy winner. His production for other artists (H.E.R., Aminé, Kali Uchis) demonstrates range. Key signal: every feature artist sounds better on a Kaytranada beat.',
    outreachEmail: '',
  },
  {
    id: 'seed-four-tet',
    name: 'Four Tet',
    genre: ['IDM', 'folktronica', 'ambient', 'house'],
    location: 'London, UK',
    monthlyListeners: 3400000,
    buzzScore: 80,
    summary: 'Four Tet has spent 25 years quietly defining what electronic music can feel like — warm, organic, and emotionally present in a genre that often prioritises cool over connection.',
    fullBrief: 'Sound Profile: Organic electronic music that samples folk, jazz, and world music through a glitchy, textured production lens. Aesthetic: warmth in a cold genre. His music sounds like it was made by hand even when it wasn\'t. Lyrical content: mostly instrumental — the emotion is carried by texture and melody. Comparable to Brian Eno\'s ambient ambition but with a stronger rhythmic foundation and more immediate accessibility. Consistently influential across the electronic spectrum — his production aesthetic has shaped a generation of producers.',
    outreachEmail: '',
  },

  // ── Afrobeats / African pop ───────────────────────────────────────────────
  {
    id: 'seed-burna-boy',
    name: 'Burna Boy',
    genre: ['Afrobeats', 'Afrofusion', 'dancehall', 'reggae'],
    location: 'Port Harcourt, Nigeria',
    monthlyListeners: 29000000,
    buzzScore: 96,
    summary: 'Burna Boy is the artist who proved Afrobeats could headline arenas globally — defiant, politically conscious, and the biggest African artist of his generation.',
    fullBrief: 'Sound Profile: Afrofusion — a blend of Afrobeats, dancehall, reggae, R&B, and hip-hop that feels simultaneously rooted in Nigerian musical tradition and completely global in ambition. Lyrical themes: Pan-African identity, colonial history, personal success against structural odds, and love as political act. Aesthetic: unapologetic African pride. His Grammy win for Twice As Tall validated the global moment for African music. Comparable to Bob Marley\'s cultural weight in how he carries political messaging through music that is simultaneously party-ready. The most important African artist in the global mainstream.',
    outreachEmail: '',
  },
  {
    id: 'seed-tems',
    name: 'Tems',
    genre: ['Afrobeats', 'R&B', 'Afrofusion', 'soul'],
    location: 'Lagos, Nigeria',
    monthlyListeners: 16000000,
    buzzScore: 92,
    summary: 'Tems has the most distinctive voice in Afrobeats — a lower register that cuts through any production, carrying emotional weight that most pop vocalists cannot approach.',
    fullBrief: 'Sound Profile: Afrofusion that leans heavily into R&B and soul. Her voice — deeper and more textured than the typical Afropop register — is the defining sonic element. Production blends traditional Afrobeats rhythms with contemporary R&B production sensibility. Lyrical themes: independence, romantic complexity, African identity, and feminine strength. Aesthetic: warmth and authority simultaneously. Her collaboration with Drake (Fountains) and Beyoncé (Move) introduced her to mainstream Western audiences without repositioning her sonic identity. Born In The Wild is a statement of artistic intent.',
    outreachEmail: '',
  },
  {
    id: 'seed-rema',
    name: 'Rema',
    genre: ['Afrobeats', 'Afropop', 'trap'],
    location: 'Benin City, Nigeria',
    monthlyListeners: 15000000,
    buzzScore: 89,
    summary: 'Rema is the youngest architect of modern Afrobeats — blending trap, Afropop, and dancehall into something his own generation recognises as theirs.',
    fullBrief: 'Sound Profile: Contemporary Afrobeats infused with trap hi-hats, melodic hooks, and a youthful energy that feels genuinely different from the generation before him. Calm Down became one of the most-streamed African songs globally. Lyrical themes: romantic pursuit, African youth identity, and the pleasure of life. Aesthetic: high energy optimism. At 23, he has already outlasted his initial "child prodigy" framing and is building a body of work. Comparable to a younger Wizkid in terms of melodic instinct but with stronger trap influence and a distinct Benin City identity.',
    outreachEmail: '',
  },
  {
    id: 'seed-amaarae',
    name: 'Amaarae',
    genre: ['Afropop', 'indie R&B', 'hyperpop', 'Afrofusion'],
    location: 'Accra, Ghana',
    monthlyListeners: 1400000,
    buzzScore: 81,
    summary: 'Amaarae is doing something nobody else in Afropop is doing — fusing hyperpop aesthetics with West African pop tradition into music that sounds futuristic and rooted simultaneously.',
    fullBrief: 'Sound Profile: Ghanaian-American fusion that blends Afropop with hyperpop production, indie R&B, and electronic elements. Her falsetto voice is the defining sonic element — thin, high, almost fragile, but emotionally precise. Lyrical themes: queer identity, Ghanaian experience, feminine desire, and identity complexity as an African diaspora artist. Aesthetic: alien beauty. Sad Gurlz Luv Money became a global sleeper hit through TikTok. Comparable to Rina Sawayama\'s genre-crossing ambition but rooted in West African tradition. Critical darling with a small but extremely devoted fanbase. Signing window still open.',
    outreachEmail: '',
  },

  // ── Latin ─────────────────────────────────────────────────────────────────
  {
    id: 'seed-rosalia',
    name: 'Rosalía',
    genre: ['flamenco', 'reggaeton', 'art pop', 'Latin pop'],
    location: 'Barcelona, Spain',
    monthlyListeners: 14000000,
    buzzScore: 93,
    summary: 'Rosalía is the most adventurous artist in Latin music — taking flamenco tradition and fusing it with reggaeton, hyperpop, and global pop production into something genuinely unprecedented.',
    fullBrief: 'Sound Profile: Experimental Latin pop that deconstructs flamenco through contemporary production — reggaeton rhythms, hyperpop aesthetics, and Spanish guitar in collision. Lyrical themes: desire, Spanish cultural identity, tradition versus modernity, and feminine power. Motomami is the defining experimental Latin album of its era — a record that nobody could have predicted and nobody can categorise. Comparable to Björk\'s willingness to use pop music as a vehicle for genuine experimental art. Grammy and Latin Grammy winner. Her visual and fashion identity are as carefully constructed as her music.',
    outreachEmail: '',
  },
  {
    id: 'seed-kali-uchis',
    name: 'Kali Uchis',
    genre: ['R&B', 'Latin pop', 'reggaeton', 'psychedelic soul'],
    location: 'Alexandria, VA',
    monthlyListeners: 13000000,
    buzzScore: 88,
    summary: 'Kali Uchis moves fluidly between English R&B and Spanish-language Latin pop, building an aesthetic world so distinct that her music is instantly recognisable.',
    fullBrief: 'Sound Profile: Retro-leaning R&B and Latin pop with strong 60s and 70s influences (bossa nova, soul, psychedelia) filtered through contemporary production. Her voice is breathy, knowing, and intimate. Lyrical themes: romantic power dynamics, Latinx identity, luxury as a political statement for a working-class Latina, and feminine independence. Aesthetic: vintage glamour reinvented. Produces in both English and Spanish with equal facility — Orquídeas (Spanish) and Red Moon in Venus (English) demonstrate bilingual artistic range. Key signal: her fanbase is bilingually diverse and extremely loyal.',
    outreachEmail: '',
  },

  // ── Emerging artists (under 500K listeners) ───────────────────────────────
  {
    id: 'seed-mk-gee',
    name: 'Mk.gee',
    genre: ['indie R&B', 'art pop', 'dream pop'],
    location: 'New Jersey, NJ',
    monthlyListeners: 620000,
    buzzScore: 84,
    summary: 'Mk.gee makes guitar-driven art pop that sounds like nothing else in his generation — strange, beautiful, and quietly building one of the most devoted fanbases in indie music.',
    fullBrief: 'Sound Profile: Warped, heavily processed guitar at the centre of R&B-influenced art pop. His production treats electric guitar the way hip-hop producers treat samples — slowed, pitched, layered. Lyrical themes: romantic yearning, inner life, surrealist imagery. Two Star & The Dream Police became a cult object. Aesthetic: beautiful strangeness. Comparable to Prince\'s idiosyncrasy but operating entirely within underground spaces. Featured extensively in music press without any industry push — entirely organic buzz. His live performances are hypnotic. Signing window is closing — label interest increasing.',
    outreachEmail: '',
  },
  {
    id: 'seed-duendita',
    name: 'duendita',
    genre: ['R&B', 'neo soul', 'experimental soul', 'jazz'],
    location: 'New York, NY',
    monthlyListeners: 180000,
    buzzScore: 71,
    summary: 'duendita makes music that operates at the intersection of jazz, neo-soul, and avant-garde art — small audience, enormous talent, wide open signing window.',
    fullBrief: 'Sound Profile: Intimate, experimental R&B rooted in jazz harmony and neo-soul tradition. Her voice is conversational and technically precise simultaneously. Production is minimal — space and silence are compositional tools. Lyrical themes: spiritual seeking, romantic grief, Afro-Caribbean identity, and the interior life of a deeply feeling person. Aesthetic: sacred music for secular times. Comparable to Erykah Badu\'s spirituality and Solange\'s conceptual ambition but with fewer resources and a rawer edge. Strong tastemaker support (Pitchfork, NPR Music) but extremely limited mainstream exposure. Monthly listeners growing organically without industry support.',
    outreachEmail: '',
  },
  {
    id: 'seed-ayra-starr',
    name: 'Ayra Starr',
    genre: ['Afropop', 'R&B', 'Afrobeats'],
    location: 'Cotonou, Benin / Lagos, Nigeria',
    monthlyListeners: 5800000,
    buzzScore: 87,
    summary: 'Ayra Starr is Mavin Records\' most complete artist — blending Afropop ease with genuine R&B sophistication at an age when most artists are still finding their sound.',
    fullBrief: 'Sound Profile: Contemporary Afropop with strong R&B influence. Her voice is supple and emotionally precise — unusually mature for an artist who debuted at 19. Lyrical themes: feminine independence, romantic confidence, African identity, and the complexity of being a young woman in public life. Aesthetic: effortless cool. Production sits between Don Jazzy\'s Afropop polish and contemporary global R&B. Rush became a global hit. Comparable to a Tems with stronger pop instincts and a more fashion-forward identity. Signed to Mavin/Republic — mainstream infrastructure supports further breakout.',
    outreachEmail: '',
  },
  {
    id: 'seed-alewya',
    name: 'Alewya',
    genre: ['art pop', 'R&B', 'electronic', 'Sudanese-influenced pop'],
    location: 'London, UK',
    monthlyListeners: 95000,
    buzzScore: 73,
    summary: 'Alewya makes visceral, percussion-forward art pop that blends East African tradition with London club music — a genuinely original sound with no current peer.',
    fullBrief: 'Sound Profile: Percussive, body-focused art pop that draws from Sudanese musical tradition, London club music, and contemporary R&B. Rhythm is the primary compositional tool. Her voice is powerful and unconventional — more interested in texture than melody. Lyrical themes: body, desire, diasporic identity, and movement as spiritual practice. Aesthetic: primal ritual meets London warehouse. Datacide/Work It Out introduced her to dance music audiences. Comparable to M.I.A.\'s collision of global sounds with confrontational energy, but with a more spiritual and less political framing. VERY early stage — wide open window. Strong industry buzz to listener ratio.',
    outreachEmail: '',
  },
  {
    id: 'seed-lava-la-rue',
    name: 'Lava La Rue',
    genre: ['indie R&B', 'neo soul', 'jazz-influenced pop'],
    location: 'London, UK',
    monthlyListeners: 220000,
    buzzScore: 69,
    summary: 'Lava La Rue is building a world at the intersection of London\'s jazz scene and contemporary R&B — queer, politically engaged, and operating entirely outside the mainstream machine.',
    fullBrief: 'Sound Profile: Jazz-influenced indie R&B that draws from the south London new jazz scene (Yussef Kamaal, Nubya Garcia) while sitting firmly in R&B and soul territory. Collective and community-focused — operates as part of a wider creative ecosystem. Lyrical themes: queer identity, working-class London life, community solidarity, and intersectional politics. Aesthetic: grassroots realness. NTS Radio and Crack Magazine are her natural press homes. Comparable to Arlo Parks at a slightly earlier stage — same emotional intelligence, similar sonic territory, less commercial polish. Independent and fiercely so.',
    outreachEmail: '',
  },
  {
    id: 'seed-omar-apollo',
    name: 'Omar Apollo',
    genre: ['indie R&B', 'pop', 'Latin pop', 'bedroom pop'],
    location: 'Hobart, IN',
    monthlyListeners: 7200000,
    buzzScore: 86,
    summary: 'Omar Apollo fuses Mexican-American identity with indie R&B and pop songwriting — melodically exceptional, emotionally direct, and growing rapidly toward mainstream crossover.',
    fullBrief: 'Sound Profile: Indie R&B with strong pop songwriting instincts. Guitar-forward production that draws from Latin pop tradition alongside contemporary R&B. His voice is malleable — moves from falsetto to chest voice with easy emotional expression. Lyrical themes: queer identity, romantic heartbreak, Mexican-American experience, and growing up between cultures. Ivory is his most complete statement. Aesthetic: bedroom pop with arena ambitions. Comparable to early Frank Ocean in his willingness to blend indie aesthetics with pop accessibility. Vermeer became a crossover hit. His songwriting is developing faster than his audience currently reflects.',
    outreachEmail: '',
  },
  {
    id: 'seed-syd',
    name: 'Syd',
    genre: ['R&B', 'neo soul', 'indie R&B'],
    location: 'Los Angeles, CA',
    monthlyListeners: 2100000,
    buzzScore: 78,
    summary: 'Syd — founder of The Internet, solo artist — makes quiet, intimate R&B that rewards close listening and has influenced a generation of producers without ever seeking the spotlight.',
    fullBrief: 'Sound Profile: Warm, bass-heavy R&B built on live instrumentation and a production aesthetic rooted in funk and soul. As a producer, she shaped the sound of a generation of artists through The Internet. Solo work is more intimate — her voice is understated, her production minimal. Lyrical themes: Black queer identity, romantic intimacy, and the quiet life. Aesthetic: cool without effort. Comparable to Erykah Badu\'s artistic independence and Prince\'s production control but operating in a more underground space. Her influence on other artists (Steve Lacy, Kaytranada) exceeds her own commercial footprint.',
    outreachEmail: '',
  },
  {
    id: 'seed-arlo-parks',
    name: 'Arlo Parks',
    genre: ['indie pop', 'bedroom pop', 'neo soul'],
    location: 'London, UK',
    monthlyListeners: 3600000,
    buzzScore: 82,
    summary: 'Arlo Parks makes intimate, literary indie pop about depression and queer experience — winning the Mercury Prize at 21 and building a devoted global following through emotional precision.',
    fullBrief: 'Sound Profile: Warm indie pop with strong neo-soul influence. Production sits between bedroom lo-fi and polished indie pop. Her spoken word background gives her lyrics an unusual density — more is packed into each line than comparable artists. Lyrical themes: mental health, queer identity, empathy for others in pain, and the specificity of everyday experience. Aesthetic: tender and literary. Collapsed In Sunbeams is the defining document of early-2020s British indie pop. Mercury Prize winner. Comparable to Sufjan Stevens\'s confessional literary approach applied to a Black British queer perspective.',
    outreachEmail: '',
  },
  {
    id: 'seed-yaeji',
    name: 'Yaeji',
    genre: ['electronic', 'house', 'indie pop', 'K-indie'],
    location: 'New York, NY',
    monthlyListeners: 1600000,
    buzzScore: 77,
    summary: 'Yaeji makes bilingual English/Korean electronic pop that operates between club music and avant-garde art — quietly one of the most original producers of her generation.',
    fullBrief: 'Sound Profile: House-influenced electronic pop that blends English and Korean lyrics. Production is minimal and hypnotic — four-on-the-floor rhythms beneath whispery, conversational vocals. Lyrical themes: Korean-American identity, domestic life examined with radical attention, and the experience of moving between cultures. Aesthetic: intimacy at club volume. Her self-production is entirely distinctive. What We Drew is a statement of intent. Comparable to Kelela\'s experimental dance music instincts but more deadpan and less vocal-forward. Strong critical following in art/music crossover spaces.',
    outreachEmail: '',
  },
]

// ─── Runner ───────────────────────────────────────────────────────────────────

async function alreadySeeded(id: string): Promise<boolean> {
  const redis = getClient()
  const exists = await redis.exists(`${KEY_PREFIX}${id}`)
  return exists === 1
}

async function main() {
  console.log(`\n🎵 Sonar Vector Seed`)
  console.log(`   Artists to seed: ${SEED_ARTISTS.length}`)
  console.log(`   Delay between embeddings: ${DELAY_MS}ms`)
  console.log(`   (Set SEED_DELAY_MS=22000 if on Voyage free tier)\n`)

  await ensureArtistIndex()

  let stored = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < SEED_ARTISTS.length; i++) {
    const artist = SEED_ARTISTS[i]
    const progress = `[${i + 1}/${SEED_ARTISTS.length}]`

    if (await alreadySeeded(artist.id)) {
      console.log(`${progress} ⏭  ${artist.name} — already seeded, skipping`)
      skipped++
      continue
    }

    try {
      process.stdout.write(`${progress} ⏳ ${artist.name} — embedding...`)
      await storeArtistVector(artist)
      console.log(` ✓`)
      stored++
    } catch (err) {
      console.log(` ✗ FAILED: ${err instanceof Error ? err.message : String(err)}`)
      failed++
    }

    // Respect rate limits — skip delay after last item
    if (i < SEED_ARTISTS.length - 1 && DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DELAY_MS))
    }
  }

  console.log(`\n✅ Seed complete`)
  console.log(`   Stored:  ${stored}`)
  console.log(`   Skipped: ${skipped} (already existed)`)
  console.log(`   Failed:  ${failed}`)
  console.log()

  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
