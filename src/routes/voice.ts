import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { transcribeAndTranslate, matchVoiceToStep } from '../services/voiceService';
import { mapVoiceToSkill, mapVoiceToExperience, mapVoiceToPay, mapVoiceToCity } from '../utils';

const router = Router();

// POST /voice/transcribe-translate
router.post('/transcribe-translate', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { text, sourceLanguage = 'hi' } = req.body;

  if (!text?.trim()) {
    res.status(400).json({ success: false, error: 'Text is required' });
    return;
  }

  const result = await transcribeAndTranslate(text, sourceLanguage);

  const structured: Record<string, unknown> = {};
  const skill = mapVoiceToSkill(result.englishText);
  if (skill) structured.primary_skill = skill;
  const exp = mapVoiceToExperience(result.englishText);
  if (exp !== null) structured.years_experience = exp;
  const pay = mapVoiceToPay(result.englishText);
  if (pay !== null) structured.min_pay_per_shift = pay;
  const city = mapVoiceToCity(result.englishText);
  if (city) structured.city = city;

  res.json({ success: true, data: { ...result, structured } });
});

// POST /voice/match-step
// Receives translated speech + step context, returns ranked option suggestions
router.post('/match-step', authMiddleware, async (req: AuthRequest, res: Response) => {
  const { originalText, translatedText, stepType, options } = req.body;

  if (!originalText?.trim() && !translatedText?.trim()) {
    res.status(400).json({ success: false, error: 'originalText or translatedText is required' });
    return;
  }

  if (!stepType) {
    res.status(400).json({ success: false, error: 'stepType is required' });
    return;
  }

  const data = matchVoiceToStep({ originalText: originalText ?? '', translatedText: translatedText ?? '', stepType, options });
  res.json({ success: true, data });
});

export default router;
