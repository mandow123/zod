import { AppError } from '../errors.js';
import {
  computeFineTuningMethods,
  computePrecisions,
  computeTaskTypes,
  computeWorkloadModes,
  type ComputeFineTuningMethod,
  type ComputePrecision,
  type ComputeRequirement,
  type ComputeTaskType,
  type ComputeWorkloadMode,
  type RequirementParseResult,
  type StructuredRequirementExtractor,
} from './types.js';

const MAX_TEXT_LENGTH = 2_000;
const CITY_NAMES = ['上海', '北京', '成都', '深圳', '广州', '杭州', '香港', '新加坡', '东京'] as const;
const MODEL_FAMILIES = ['qwen', 'llama', 'deepseek', 'mistral', 'gemma', 'glm', 'yi', 'baichuan'] as const;

function firstNumber(text: string, expression: RegExp): number | null {
  const match = expression.exec(text);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : null;
}
function roundedVram(value: number) {
  return Math.max(8, Math.min(2_048, Math.ceil(value / 8) * 8));
}

function taskType(text: string): ComputeTaskType {
  if (/(?:微调|fine[- ]?tun)/iu.test(text)) return 'fine_tuning';
  if (/(?:推理|inference|部署模型)/iu.test(text)) return 'inference';
  if (/(?:渲染|render)/iu.test(text)) return 'rendering';
  if (/(?:训练|train)/iu.test(text)) return 'training';
  return 'other';
}

function fineTuningMethod(text: string, task: ComputeTaskType): ComputeFineTuningMethod {
  if (task !== 'fine_tuning') return 'not_applicable';
  if (/qlora/iu.test(text)) return 'qlora';
  if (/\blora\b/iu.test(text)) return 'lora';
  if (/(?:全量微调|全参数|full[- ]?ft|full fine)/iu.test(text)) return 'full_ft';
  return 'lora';
}

function precision(text: string): ComputePrecision {
  const match = /\b(fp32|fp16|bf16|fp8|int8|int4)\b/iu.exec(text);
  return (match?.[1]?.toLowerCase() as ComputePrecision | undefined) ?? 'unspecified';
}

function modelFamily(text: string) {
  const lowered = text.toLowerCase();
  return MODEL_FAMILIES.find((family) => lowered.includes(family)) ?? null;
}

function datasetRows(text: string) {
  const match = /(\d+(?:\.\d+)?)\s*(万|亿)?\s*(?:条|样本|records?)/iu.exec(text);
  if (!match?.[1]) return null;
  const multiplier = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}

function deadlineHours(text: string) {
  if (/(?:一天|1\s*天)内/iu.test(text)) return 24;
  const hours = firstNumber(text, /(\d+(?:\.\d+)?)\s*(?:小时|h(?:ours?)?)\s*内/iu);
  if (hours !== null) return hours;
  const days = firstNumber(text, /(\d+(?:\.\d+)?)\s*(?:天|d(?:ays?)?)\s*内/iu);
  return days === null ? null : days * 24;
}

function durationHours(text: string, deadline: number | null) {
  const hours = firstNumber(text, /(?:跑|使用|租用|时长|duration)?\s*(\d+(?:\.\d+)?)\s*(?:小时|h(?:ours?)?)/iu);
  if (hours !== null) return hours;
  const days = firstNumber(text, /(?:跑|使用|租用|时长|duration)?\s*(\d+(?:\.\d+)?)\s*(?:天|d(?:ays?)?)/iu);
  if (days !== null) return days * 24;
  return deadline ?? 24;
}

function explicitVram(text: string) {
  return firstNumber(text, /(\d+(?:\.\d+)?)\s*(?:gib|gb)\s*(?:显存|vram)/iu)
    ?? firstNumber(text, /(?:显存|vram)\s*(?:至少|不低于|>=?)?\s*(\d+(?:\.\d+)?)\s*(?:gib|gb)?/iu);
}

function estimateVram(modelSizeBillions: number | null, method: ComputeFineTuningMethod, mode: ComputeWorkloadMode, value: ComputePrecision) {
  if (modelSizeBillions === null) return 24;
  if (mode === 'inference') {
    const bytes = ({ fp32: 4.8, fp16: 2.4, bf16: 2.4, fp8: 1.4, int8: 1.4, int4: 0.8, unspecified: 2.4 } as const)[value];
    return roundedVram(modelSizeBillions * bytes + 4);
  }
  if (method === 'full_ft') return roundedVram(modelSizeBillions * 16 + 16);
  if (method === 'qlora') return roundedVram(modelSizeBillions * 2.5 + 8);
  return roundedVram(modelSizeBillions * 4 + 12);
}

function budgetCny(text: string) {
  return firstNumber(text, /(?:预算|不超过|最多)\s*(?:人民币|rmb|¥|￥)?\s*(\d+(?:\.\d+)?)\s*(?:元|cny)?/iu);
}

function percentage(text: string, label: RegExp) {
  const match = label.exec(text);
  const value = match?.[1] ? Number(match[1]) : Number.NaN;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function deterministicDraft(text: string): ComputeRequirement {
  const parsedTask = taskType(text);
  const workload: ComputeWorkloadMode = parsedTask === 'inference' ? 'inference' : 'training';
  const method = fineTuningMethod(text, parsedTask);
  const parsedPrecision = precision(text);
  const modelSize = firstNumber(text, /(\d+(?:\.\d+)?)\s*[bB]\b/u);
  const deadline = deadlineHours(text);
  const vram = explicitVram(text) ?? estimateVram(modelSize, method, workload, parsedPrecision);
  const region = CITY_NAMES.find((city) => text.includes(city)) ?? null;
  return {
    taskType: parsedTask,
    workload,
    modelFamily: modelFamily(text),
    modelSizeBillions: modelSize,
    datasetRows: datasetRows(text),
    fineTuningMethod: method,
    estimatedVramGiBPerGpu: roundedVram(vram),
    gpuCount: Math.round(firstNumber(text, /(\d+)\s*(?:张|块|卡|个)\s*(?:gpu|显卡)?/iu) ?? 1),
    deadlineHours: deadline,
    budgetCny: budgetCny(text),
    region,
    durationHours: durationHours(text, deadline),
    precision: parsedPrecision,
    minimumReliabilityPercent: percentage(text, /(?:可靠性|reliability)\s*(?:至少|不低于|>=?)?\s*(\d+(?:\.\d+)?)\s*%/iu),
    minimumSlaAvailabilityPercent: percentage(text, /(?:sla|可用性|availability)\s*(?:至少|不低于|>=?)?\s*(\d+(?:\.\d+)?)\s*%/iu),
  };
}

function optionalNumber(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

function nullableNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null) return null;
  return optionalNumber(value, minimum, maximum);
}

function enumValue<T extends string>(value: unknown, values: readonly T[]) {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined;
}

function mergeStructuredDraft(base: ComputeRequirement, value: unknown): ComputeRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  const draft = value as Record<string, unknown>;
  const family = draft.modelFamily === null
    ? null
    : typeof draft.modelFamily === 'string' && draft.modelFamily.trim().length <= 80
      ? draft.modelFamily.trim().toLowerCase() : undefined;
  return {
    taskType: enumValue(draft.taskType, computeTaskTypes) ?? base.taskType,
    workload: enumValue(draft.workload, computeWorkloadModes) ?? base.workload,
    modelFamily: family === undefined ? base.modelFamily : family,
    modelSizeBillions: nullableNumber(draft.modelSizeBillions, 0.1, 10_000) ?? base.modelSizeBillions,
    datasetRows: nullableNumber(draft.datasetRows, 1, 10_000_000_000) ?? base.datasetRows,
    fineTuningMethod: enumValue(draft.fineTuningMethod, computeFineTuningMethods) ?? base.fineTuningMethod,
    estimatedVramGiBPerGpu: optionalNumber(draft.estimatedVramGiBPerGpu, 1, 2_048) ?? base.estimatedVramGiBPerGpu,
    gpuCount: Math.round(optionalNumber(draft.gpuCount, 1, 256) ?? base.gpuCount),
    deadlineHours: nullableNumber(draft.deadlineHours, 0.25, 8_784) ?? base.deadlineHours,
    budgetCny: nullableNumber(draft.budgetCny, 0.01, 1_000_000_000) ?? base.budgetCny,
    region: draft.region === null ? null : typeof draft.region === 'string' && draft.region.trim().length <= 80
      ? draft.region.trim() : base.region,
    durationHours: optionalNumber(draft.durationHours, 0.25, 8_784) ?? base.durationHours,
    precision: enumValue(draft.precision, computePrecisions) ?? base.precision,
    minimumReliabilityPercent: nullableNumber(draft.minimumReliabilityPercent, 0, 100) ?? base.minimumReliabilityPercent,
    minimumSlaAvailabilityPercent: nullableNumber(draft.minimumSlaAvailabilityPercent, 0, 100) ?? base.minimumSlaAvailabilityPercent,
  };
}

function validateRequirement(requirement: ComputeRequirement) {
  if (!Number.isInteger(requirement.gpuCount) || requirement.gpuCount < 1 || requirement.gpuCount > 256) {
    throw new AppError('COMPUTE_REQUIREMENT_GPU_COUNT_INVALID', 400, 'GPU 数量必须在 1 到 256 之间。');
  }
  if (!Number.isFinite(requirement.estimatedVramGiBPerGpu) || requirement.estimatedVramGiBPerGpu < 1
    || requirement.estimatedVramGiBPerGpu > 2_048) {
    throw new AppError('COMPUTE_REQUIREMENT_VRAM_INVALID', 400, '单卡显存估算必须在 1 到 2048 GiB 之间。');
  }
  if (!Number.isFinite(requirement.durationHours) || requirement.durationHours < 0.25 || requirement.durationHours > 8_784) {
    throw new AppError('COMPUTE_REQUIREMENT_DURATION_INVALID', 400, '使用时长必须在 0.25 到 8784 小时之间。');
  }
  if (requirement.deadlineHours !== null && requirement.durationHours > requirement.deadlineHours) {
    throw new AppError('COMPUTE_REQUIREMENT_DEADLINE_INVALID', 400, '预计使用时长不能超过截止时间。');
  }
  return requirement;
}

function parseNotes(text: string, requirement: ComputeRequirement) {
  const assumptions: string[] = [];
  const uncertainties: string[] = [];
  if (requirement.taskType === 'fine_tuning' && !/(?:qlora|\blora\b|全量微调|全参数|full[- ]?ft)/iu.test(text)) {
    assumptions.push('未指定微调方法，预览暂按 LoRA 估算；下单前必须由用户确认。');
  }
  if (requirement.modelSizeBillions === null) uncertainties.push('未识别模型参数规模，显存估算只使用安全兜底值。');
  if (explicitVram(text) === null) assumptions.push('显存为确定性估算值，不是实测训练峰值。');
  if (requirement.region === null) assumptions.push('未指定地区，候选不按地区做硬过滤。');
  if (requirement.budgetCny === null) uncertainties.push('未提供预算，候选不会执行预算硬过滤。');
  if (requirement.deadlineHours === null) uncertainties.push('未提供截止时间，无法验证 deadline。');
  assumptions.push('当前 inventory 缺少工作负载吞吐 benchmark，时长与 deadline 只能做容量窗口检查。');
  return { assumptions, uncertainties };
}

export class ComputeRequirementParser {
  constructor(private readonly extractor?: StructuredRequirementExtractor) {}

  async parse(text: string, confirmed?: ComputeRequirement): Promise<RequirementParseResult> {
    const normalized = text.normalize('NFKC').trim();
    if (normalized.length < 4 || normalized.length > MAX_TEXT_LENGTH) {
      throw new AppError('COMPUTE_REQUIREMENT_TEXT_INVALID', 400, '算力需求需为 4 到 2000 个字符。');
    }
    const base = deterministicDraft(normalized);
    if (confirmed) {
      const requirement = validateRequirement(mergeStructuredDraft(base, confirmed));
      const notes = parseNotes(normalized, requirement);
      return { requirement, parser: { mode: 'user_confirmed', version: 'compute-requirement-v1' },
        ...notes, confirmationRequired: false };
    }
    let draft: unknown;
    let mode: RequirementParseResult['parser']['mode'] = 'deterministic';
    if (this.extractor) {
      try {
        draft = await this.extractor.extract(normalized);
        mode = 'llm_structured_output';
      } catch {
        mode = 'deterministic_fallback';
      }
    }
    const requirement = validateRequirement(mergeStructuredDraft(base, draft));
    return {
      requirement,
      parser: { mode, version: 'compute-requirement-v1' },
      ...parseNotes(normalized, requirement),
      confirmationRequired: true,
    };
  }
}
