import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { Job } from '../models/Job';
import { Employer } from '../models/Employer';
import { Worker } from '../models/Worker';
import { MarketRate } from '../models/MarketRate';
import { Application } from '../models/Application';
import { JobTemplate } from '../models/JobTemplate';
import { broadcastFlashJob, computeSUPS } from '../services/dispatchService';
import type { FilterQuery } from 'mongoose';
import { deriveLaneExpiry } from '../utils/contract-helpers';

const router = Router();

function haversineKm(coords1: [number, number], coords2: [number, number]): number {
  const [lng1, lat1] = coords1;
  const [lng2, lat2] = coords2;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

// GET /jobs/feed — Worker job feed
router.get('/feed', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    // 1. Fetch Worker and applied job IDs concurrently
    const worker = await Worker.findOne({ user_id: req.user!.userId }).lean();
    if (!worker) {
      res.status(404).json({ success: false, error: 'Worker profile not found' });
      return;
    }

    // 2. Sanitize and Extract Query Params
    const { lane, min_pay, page = 1, limit = 20, skill, lat, lng } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(50, Math.max(1, Number(limit)));

    const overrideLat = lat !== undefined ? Number(lat) : undefined;
    const overrideLng = lng !== undefined ? Number(lng) : undefined;

    const workerCoords = Number.isFinite(overrideLat) && Number.isFinite(overrideLng)
      ? [overrideLng as number, overrideLat as number]
      : (worker.last_known_location || worker.home_location)?.coordinates;

    const max_distance_meters = (req.query.max_distance_km !== undefined
      ? Number(req.query.max_distance_km)
      : (worker.preferred_radius_km || 15)) * 1000;

    // 3. Fetch applied job IDs — only job_id field, indexed query
    const appliedDocs = await Application.find({ worker_id: worker._id })
      .select('job_id')
      .lean();
    const appliedJobIds = appliedDocs.map(a => a.job_id);

    // 4. Construct Query Conditions
    const now = new Date();
    const andConditions: FilterQuery<typeof Job>[] = [
      { $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: now } }] },
    ];

    if (appliedJobIds.length > 0) {
      andConditions.push({ _id: { $nin: appliedJobIds } });
    }

    const effectiveMinPay = Math.max(
      min_pay ? Number(min_pay) : 0,
      worker.min_pay_per_shift ?? 0
    );

    if (effectiveMinPay > 0) {
      andConditions.push({
        $or: [{ pay_rate: { $gte: effectiveMinPay } }, { pay_min: { $gte: effectiveMinPay } }]
      });
    }

    const query: FilterQuery<typeof Job> = {
      status: { $in: ['BROADCASTING', 'PARTIALLY_FILLED'] },
      is_demo_post: { $ne: true },
      primary_skill: skill ? String(skill) : worker.primary_skill,
      $and: andConditions,
    };

    if (workerCoords) {
      query.location = {
        $near: {
          $geometry: { type: 'Point', coordinates: workerCoords },
          $maxDistance: max_distance_meters,
        },
      };
    }

    if (lane) query.lane = Number(lane);

    // 5. Fetch limit+1 to determine has_more without a separate count query
    const jobs = await Job.find(query)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum + 1)
      .lean();

    const has_more = jobs.length > limitNum;
    const pageJobs = has_more ? jobs.slice(0, limitNum) : jobs;

    if (pageJobs.length === 0) {
      res.json({ success: true, data: [], page: pageNum, has_more: false });
      return;
    }

    // 6. Parallel Data Fetching (Employers & Market Rates)
    const employerIds = [...new Set(pageJobs.map(j => j.employer_id.toString()))];
    const uniqueSkills = [...new Set(pageJobs.map(j => j.primary_skill))];

    const [employers, marketRates] = await Promise.all([
      Employer.find({ _id: { $in: employerIds } })
        .select('property_type area_locality dignity_score gstin_verified')
        .lean(),
      MarketRate.find({ city: worker.city, skill: { $in: uniqueSkills } }).lean()
    ]);

    const employerMap = new Map(employers.map(e => [e._id.toString(), e]));
    const marketRateMap = new Map(marketRates.map(r => [`${r.city}:${r.skill}`, r.median]));

    // 7. Map Feed Responses — run all SUPS concurrently
    const feedPromises = pageJobs.map(async (job) => {
      const employer = employerMap.get(job.employer_id.toString());
      if (!employer) return null;
      if (employer.dignity_score < worker.min_dignity_score) return null;

      const distance_km = workerCoords && job.location?.coordinates
        ? haversineKm(workerCoords as [number, number], job.location.coordinates)
        : undefined;

      const sups_score = await computeSUPS(worker._id.toString(), job._id.toString());

      const marketMedian = marketRateMap.get(`${worker.city}:${job.primary_skill}`);
      const market_rate_delta = marketMedian !== undefined && job.pay_rate !== undefined
        ? job.pay_rate - marketMedian
        : undefined;

      return {
        _id: job._id,
        job_title: job.job_title,
        primary_skill: job.primary_skill,
        pay_rate: job.pay_rate,
        pay_type: job.pay_type,
        shift_start_time: job.shift_start_time,
        shift_duration_hours: job.shift_duration_hours,
        number_of_openings: job.number_of_openings,
        openings_filled: job.openings_filled,
        lane: job.lane,
        expires_at: job.expires_at,
        location: job.location,
        pay_type: job.pay_type,
        pay_min: job.pay_min,
        pay_max: job.pay_max,
        distance_km,
        sups_score,
        market_rate_delta,
        employer_property_type: employer.property_type,
        employer_area_locality: employer.area_locality,
        employer_dignity_score: employer.dignity_score,
        employer_gstin_verified: employer.gstin_verified,
      };
    });

    const feed = (await Promise.all(feedPromises)).filter(Boolean);

    res.json({ success: true, data: feed, page: pageNum, has_more });
  } catch (err) {
    console.error('Feed error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch job feed' });
  }
});

// GET /jobs/mine — List all jobs posted by the employer
router.get('/mine', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const employer = await Employer.findOne({ user_id: req.user!.userId });
    if (!employer) {
      res.status(403).json({ success: false, error: 'Not an employer' });
      return;
    }

    const jobs = await Job.find({ employer_id: employer._id })
      .sort({ created_at: -1 })
      .lean();

    const jobsWithCounts = await Promise.all(jobs.map(async (job) => {
      const applicantCount = await Application.countDocuments({ job_id: job._id });
      return {
        _id: job._id,
        job_title: job.job_title,
        lane: job.lane,
        status: job.status,
        applicant_count: applicantCount,
        pay_rate: job.pay_rate || job.pay_min
      };
    }));

    res.json({ success: true, data: jobsWithCounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Failed to fetch jobs' });
  }
});

// GET /jobs/templates — Employer job templates
router.get('/templates', authMiddleware, async (req: AuthRequest, res: Response) => {
  const employer = await Employer.findOne({ user_id: req.user!.userId });
  if (!employer) {
    res.status(403).json({ success: false, error: 'Not an employer' });
    return;
  }

  const templates = await JobTemplate.find({ employer_id: employer._id })
    .sort({ last_used_at: -1, created_at: -1 })
    .limit(20)
    .lean();

  res.json({
    success: true,
    data: templates.map((template) => ({
      _id: template._id,
      job_title: template.job_title,
      primary_skill: template.primary_skill,
      description: template.special_instructions ?? '',
      pay_rate: template.pay_rate ?? 0,
      shift_duration_hours: template.shift_duration_hours ?? 8,
      number_of_openings: 1,
      lane: template.lane,
    })),
  });
});

// GET /jobs/:id — Job detail
router.get('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const job = await Job.findById(req.params.id).lean();
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  const [worker, employer] = await Promise.all([
    Worker.findOne({ user_id: req.user!.userId }).select('last_known_location home_location').lean(),
    Employer.findById(job.employer_id)
      .select('-location_address -contact_name -contact_phone -entry_instructions -gstin')
      .lean(),
  ]);

  const workerCoords = (worker?.last_known_location || worker?.home_location)?.coordinates;
  const jobCoords = job.location?.coordinates;
  const distance_km = workerCoords && jobCoords
    ? haversineKm(workerCoords as [number, number], jobCoords)
    : null;

  // Check if this worker already applied — only fetch needed fields
  const existingApplication = worker
    ? await Application.findOne({ job_id: job._id, worker_id: (worker as any)._id })
      .select('_id status')
      .lean()
    : null;

  res.json({
    success: true,
    data: {
      // Core
      _id: job._id,
      lane: job.lane,
      status: job.status,
      is_demo_post: job.is_demo_post,
      job_title: job.job_title,
      primary_skill: job.primary_skill,
      secondary_skills_preferred: job.secondary_skills_preferred ?? [],
      cuisine_preferred: job.cuisine_preferred ?? [],
      description: job.job_description ?? '',
      special_instructions: job.special_instructions ?? '',
      // Pay
      pay_rate: job.pay_rate ?? null,
      pay_type: job.pay_type,
      pay_min: job.pay_min ?? null,
      pay_max: job.pay_max ?? null,
      pay_vs_market: job.pay_vs_market ?? null,
      // Shift (L1/L2)
      shift_start_time: job.shift_start_time ?? null,
      shift_end_time: job.shift_end_time ?? null,
      shift_duration_hours: job.shift_duration_hours ?? null,
      // Openings
      number_of_openings: job.number_of_openings,
      openings_filled: job.openings_filled,
      // Requirements
      experience_years_min: job.experience_years_min ?? null,
      minimum_qualification: job.minimum_qualification ?? '',
      // Contract (L3/L4)
      contract_start_date: job.contract_start_date ?? null,
      contract_duration: job.contract_duration ?? '',
      notice_period_max_days: job.notice_period_max_days ?? null,
      // Interview (L4)
      interview_required: job.interview_required ?? false,
      interview_format: job.interview_format ?? null,
      // Lifecycle
      expires_at: job.expires_at ?? null,
      boost_active: job.boost_active ?? false,
      cream_pool_first: job.cream_pool_first ?? false,
      // Location
      distance_km,
      // Perks
      meals_provided: job.meals_provided ?? false,
      accommodation_provided: job.accommodation_provided ?? false,
      transport_provided: job.transport_provided ?? false,
      uniform_provided: Boolean(job.uniform_required),
      uniform_details: job.uniform_required ?? '',
      // Employer
      employer_id: employer?._id ?? job.employer_id,
      employer_property_name: employer?.property_name ?? '',
      employer_property_type: employer?.property_type ?? '',
      employer_property_segment: employer?.property_segment ?? '',
      employer_area_locality: employer?.area_locality ?? '',
      employer_city: employer?.city ?? '',
      employer_location_landmark: employer?.location_landmark ?? '',
      employer_nearest_metro: employer?.nearest_metro_or_bus ?? '',
      employer_parking_available: employer?.parking_available ?? false,
      employer_cuisine_types: employer?.cuisine_types ?? [],
      employer_covers_capacity: employer?.covers_capacity ?? null,
      employer_number_of_rooms: employer?.number_of_rooms ?? null,
      employer_brand_affiliation: employer?.brand_affiliation ?? '',
      employer_year_established: employer?.year_established ?? null,
      employer_dignity_score: employer?.dignity_score ?? 0,
      employer_dignity_state: employer?.dignity_state ?? 'NEW',
      employer_gstin_verified: employer?.gstin_verified ?? false,
      employer_fssai_verified: employer?.fssai_verified ?? false,
      employer_liquor_license: employer?.liquor_license ?? false,
      employer_psara_registered: employer?.psara_registered ?? false,
      employer_verified_badge: employer?.verified_employer_badge ?? false,
      employer_confirmation_rate: employer?.confirmation_rate ?? null,
      employer_pay_accuracy_rate: employer?.pay_accuracy_rate ?? null,
      employer_fair_treatment_rate: employer?.fair_treatment_rate ?? null,
      employer_worker_return_rate: employer?.worker_return_rate ?? null,
      employer_total_confirmed_arrivals: employer?.total_confirmed_arrivals ?? 0,
      // Application state
      has_applied: !!existingApplication,
      application_id: existingApplication?._id ?? null,
      application_status: existingApplication?.status ?? null,
    },
  });
});

// POST /jobs — Create job (employer)
router.post('/create', authMiddleware, async (req: AuthRequest, res: Response) => {
  const employer = await Employer.findOne({ user_id: req.user!.userId });
  if (!employer) {
    res.status(403).json({ success: false, error: 'Not an employer' });
    return;
  }

  if (employer.confirm_gate_blocked) {
    res.status(403).json({ success: false, error: 'Confirm gate blocked', confirm_gate_reason: employer.confirm_gate_reason });
    return;
  }

  if (employer.posts_this_month >= employer.monthly_post_limit && employer.monthly_post_limit !== -1) {
    res.status(403).json({ success: false, error: 'Monthly post limit reached' });
    return;
  }

  const lane = Number(req.body.lane);
  const payRate = Number(req.body.pay_rate);
  const openings = req.body.number_of_openings !== undefined ? Number(req.body.number_of_openings) : 1;
  const durationHours = req.body.shift_duration_hours !== undefined ? Number(req.body.shift_duration_hours) : undefined;
  const shiftStartTime = req.body.shift_start_time ? new Date(req.body.shift_start_time) : undefined;

  if (![1, 2, 3, 4].includes(lane)) {
    res.status(400).json({ success: false, error: 'lane must be one of 1, 2, 3, or 4' });
    return;
  }
  if (typeof req.body.job_title !== 'string' || !req.body.job_title.trim()) {
    res.status(400).json({ success: false, error: 'job_title is required' });
    return;
  }
  if (typeof req.body.primary_skill !== 'string' || !req.body.primary_skill.trim()) {
    res.status(400).json({ success: false, error: 'primary_skill is required' });
    return;
  }
  if (!Number.isFinite(payRate) || payRate <= 0) {
    res.status(400).json({ success: false, error: 'pay_rate must be a positive number' });
    return;
  }
  if (!Number.isFinite(openings) || openings <= 0) {
    res.status(400).json({ success: false, error: 'number_of_openings must be at least 1' });
    return;
  }
  if (durationHours !== undefined && (!Number.isFinite(durationHours) || durationHours <= 0)) {
    res.status(400).json({ success: false, error: 'shift_duration_hours must be a positive number' });
    return;
  }
  if (shiftStartTime && Number.isNaN(shiftStartTime.getTime())) {
    res.status(400).json({ success: false, error: 'shift_start_time must be a valid date' });
    return;
  }

  const now = new Date();
  if (lane === 1 && shiftStartTime && shiftStartTime.getTime() > now.getTime() + 6 * 60 * 60 * 1000) {
    res.status(400).json({ success: false, error: 'Lane 1 jobs must start within the next 6 hours' });
    return;
  }
  if (lane === 2 && shiftStartTime && shiftStartTime.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    res.status(400).json({ success: false, error: 'Lane 2 jobs must start within the next 24 hours' });
    return;
  }

  const jobData: any = {
    lane,
    job_title: req.body.job_title.trim(),
    job_description: typeof req.body.description === 'string' ? req.body.description.trim() : undefined,
    primary_skill: req.body.primary_skill.trim(),
    pay_rate: payRate,
    shift_duration_hours: durationHours,
    number_of_openings: openings,
    keywords_extracted: Array.isArray(req.body.keywords_extracted) ? req.body.keywords_extracted.filter((value: unknown) => typeof value === 'string') : [],
    employer_id: employer._id,
    location: employer.location,
    status: 'BROADCASTING',
    shift_start_time: shiftStartTime,
  };

  jobData.expires_at = deriveLaneExpiry({
    lane,
    now,
    shiftStartTime: shiftStartTime?.toISOString(),
  });

  const job = await Job.create(jobData);

  await JobTemplate.findOneAndUpdate(
    { employer_id: employer._id, lane, primary_skill: job.primary_skill, job_title: job.job_title },
    {
      $set: {
        pay_rate: job.pay_rate,
        shift_duration_hours: job.shift_duration_hours,
        special_instructions: job.job_description,
        last_used_at: new Date(),
      },
      $setOnInsert: {
        template_name: `${job.job_title} template`,
        killer_questions: [],
      },
      $inc: { usage_count: 1 },
    },
    { upsert: true, new: true }
  );

  await Employer.updateOne({ _id: employer._id }, { $inc: { posts_this_month: 1, total_jobs_posted: 1 } });

  // Fire L1 broadcast asynchronously
  if (job.lane === 1) {
    broadcastFlashJob(job._id.toString()).catch(console.error);
  }

  res.status(201).json({ success: true, data: { job_id: job._id } });
});

// PATCH /jobs/:id — Update job
router.patch('/:id', authMiddleware, async (req: AuthRequest, res: Response) => {
  const employer = await Employer.findOne({ user_id: req.user!.userId });
  if (!employer) {
    res.status(403).json({ success: false, error: 'Not an employer' });
    return;
  }

  const job = await Job.findOneAndUpdate(
    { _id: req.params.id, employer_id: employer._id },
    { $set: req.body },
    { new: true }
  );

  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found' });
    return;
  }

  res.json({ success: true, data: job });
});

export default router;
