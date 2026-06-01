import axios from 'axios';
import { extractKeywords, mapVoiceToCity } from '../utils';
import { SKILL_LIST, CUISINE_LIST } from '../utils/constants';

const GOOGLE_TRANSLATE_API = 'https://translation.googleapis.com/language/translate/v2';

export async function transcribeAndTranslate(text: string, sourceLanguage: string): Promise<{
  originalText: string;
  englishText: string;
  keywords: string[];
  detectedLanguage?: string;
}> {
  if (!text?.trim()) {
    return { originalText: '', englishText: '', keywords: [] };
  }

  if (sourceLanguage === 'en') {
    return {
      originalText: text,
      englishText: text,
      keywords: extractKeywords(text),
    };
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('GOOGLE_API_KEY not set — voice translation unavailable');
    return {
      originalText: text,
      englishText: text,
      keywords: extractKeywords(text),
    };
  }

  try {
    const response = await axios.post(`${GOOGLE_TRANSLATE_API}?key=${apiKey}`, {
      q: text,
      source: sourceLanguage !== 'auto' ? sourceLanguage : undefined,
      target: 'en',
      format: 'text',
    }, { family: 4 });

    const translation = response.data?.data?.translations?.[0];
    const englishText = translation?.translatedText ?? text;
    const detectedLanguage = translation?.detectedSourceLanguage;

    return {
      originalText: text,
      englishText,
      keywords: extractKeywords(englishText),
      detectedLanguage,
    };
  } catch (err: any) {
    // Surface the specific Google API error so it's diagnosable in logs
    console.error('Translation error:', err?.response?.data ?? err?.message ?? err);
    return {
      originalText: text,
      englishText: text,
      keywords: extractKeywords(text),
    };
  }
}

// ─── Step matching ────────────────────────────────────────────────────────────

type StepOption = { id: string; label: string; aliases?: string[] };
type VoiceSuggestion = { id: string; label: string; nativeLabel: string; confidence: number };
type VoiceMatchResult =
  | { type: 'options'; items: VoiceSuggestion[]; multiSelect: boolean }
  | { type: 'availability'; days: VoiceSuggestion[]; shifts: VoiceSuggestion[] }
  | { type: 'no_match' };

const DAY_MAP: Record<string, string> = {
  mon: 'Mon', monday: 'Mon',
  tue: 'Tue', tuesday: 'Tue',
  wed: 'Wed', wednesday: 'Wed',
  thu: 'Thu', thursday: 'Thu',
  fri: 'Fri', friday: 'Fri',
  sat: 'Sat', saturday: 'Sat',
  sun: 'Sun', sunday: 'Sun',
  somvar: 'Mon', mangalvar: 'Tue', budhvar: 'Wed',
  guruvar: 'Thu', shukravar: 'Fri', shanivar: 'Sat', ravivar: 'Sun',
};

const SHIFT_MAP = [
  { id: 'morning',   label: 'Morning',   aliases: ['morning', 'dawn', 'early', 'breakfast', 'subah', 'prabhat'] },
  { id: 'afternoon', label: 'Afternoon', aliases: ['afternoon', 'midday', 'noon', 'lunch', 'dopahar', 'din'] },
  { id: 'evening',   label: 'Evening',   aliases: ['evening', 'shaam', 'dusk', 'dinner', 'sandhya'] },
  { id: 'night',     label: 'Night',     aliases: ['night', 'raat', 'late', 'midnight', 'nisha'] },
];

function scoreOption(text: string, opt: StepOption): number {
  let score = 0;
  const lower = text.toLowerCase();
  if (lower.includes(opt.label.toLowerCase())) score += 1.0;
  if (opt.aliases) {
    for (const alias of opt.aliases) {
      if (lower.includes(alias.toLowerCase())) { score += 0.8; break; }
    }
  }
  return score;
}

function matchOptions(
  searchText: string,
  originalText: string,
  options: StepOption[],
  multiSelect: boolean,
): VoiceMatchResult {
  const scored = options
    .map((opt) => ({ opt, score: scoreOption(searchText, opt) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (scored.length === 0) return { type: 'no_match' };

  const maxScore = scored[0].score;
  return {
    type: 'options',
    multiSelect,
    items: scored.map(({ opt, score }) => ({
      id: opt.id,
      label: opt.label,
      nativeLabel: originalText,
      confidence: Math.min(score / maxScore, 1),
    })),
  };
}

function matchAvailability(searchText: string, originalText: string): VoiceMatchResult {
  const lower = searchText.toLowerCase();

  // Collect matched day IDs
  const matchedDays = new Set<string>();
  for (const [alias, dayId] of Object.entries(DAY_MAP)) {
    if (lower.includes(alias)) matchedDays.add(dayId);
  }

  // Expand ranges: "monday to friday" / "mon-fri"
  const rangeMatch = lower.match(/(\w+)\s*(?:to|-)\s*(\w+)/);
  if (rangeMatch) {
    const allDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const from = DAY_MAP[rangeMatch[1]];
    const to   = DAY_MAP[rangeMatch[2]];
    if (from && to) {
      const fi = allDays.indexOf(from);
      const ti = allDays.indexOf(to);
      if (fi !== -1 && ti !== -1 && fi <= ti) {
        for (let i = fi; i <= ti; i++) matchedDays.add(allDays[i]);
      }
    }
  }

  const matchedShifts: VoiceSuggestion[] = [];
  for (const shift of SHIFT_MAP) {
    for (const alias of shift.aliases) {
      if (lower.includes(alias)) {
        matchedShifts.push({ id: shift.id, label: shift.label, nativeLabel: originalText, confidence: 0.85 });
        break;
      }
    }
  }

  const days: VoiceSuggestion[] = Array.from(matchedDays).map((d) => ({
    id: d, label: d, nativeLabel: originalText, confidence: 0.9,
  }));

  if (days.length === 0 && matchedShifts.length === 0) return { type: 'no_match' };
  return { type: 'availability', days, shifts: matchedShifts };
}

export function matchVoiceToStep(params: {
  originalText: string;
  translatedText: string;
  stepType: string;
  options?: StepOption[];
}): VoiceMatchResult {
  const { originalText, translatedText, stepType, options = [] } = params;
  // Use translated (English) text for matching; fall back to original if translation was a no-op
  const searchText = translatedText || originalText;

  if (stepType === 'availability') {
    return matchAvailability(searchText, originalText);
  }

  // For role: if no options provided from client, use the server-side SKILL_LIST
  if (stepType === 'role' && options.length === 0) {
    const builtIn = SKILL_LIST.map((s) => ({
      id: s.id,
      label: s.labelEn,
      aliases: [...s.keywords],
    }));
    return matchOptions(searchText, originalText, builtIn, false);
  }

  // sub_skill / location / custom options supplied by client
  if (options.length > 0) {
    return matchOptions(searchText, originalText, options, stepType === 'sub_skill');
  }

  return { type: 'no_match' };
}
