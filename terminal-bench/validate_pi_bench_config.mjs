#!/usr/bin/env node

import { supportsXhigh } from "../pi/packages/ai/dist/models.js";
import { MODELS } from "../pi/packages/ai/dist/models.generated.js";
import { allToolNames } from "../pi/packages/coding-agent/dist/core/tools/index.js";

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function flattenModels() {
	const models = [];
	for (const providerModels of Object.values(MODELS)) {
		for (const model of Object.values(providerModels)) {
			models.push(model);
		}
	}
	return models;
}

function findExactModelReferenceMatch(modelReference, availableModels) {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) return undefined;

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) return canonicalMatches[0];
	if (canonicalMatches.length > 1) return undefined;

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) return providerMatches[0];
			if (providerMatches.length > 1) return undefined;
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function fail(message) {
	console.error(`ERROR: ${message}`);
	process.exit(1);
}

const model = process.env.PI_BENCH_MODEL ?? "";
const thinking = process.env.PI_BENCH_THINKING ?? "";
const toolsCsv = process.env.PI_BENCH_TOOLS ?? "";

if (!VALID_THINKING_LEVELS.has(thinking)) {
	fail(`Invalid PI_BENCH_THINKING "${thinking}". Valid values: ${Array.from(VALID_THINKING_LEVELS).join(", ")}`);
}

const availableTools = allToolNames;
const requestedTools = toolsCsv
	.split(",")
	.map((tool) => tool.trim())
	.filter(Boolean);

if (requestedTools.length === 0) {
	fail("PI_BENCH_TOOLS must include at least one tool.");
}

for (const tool of requestedTools) {
	if (!availableTools.has(tool)) {
		fail(`Invalid PI_BENCH_TOOLS entry "${tool}". Valid tools: ${Array.from(availableTools).join(", ")}`);
	}
}

const resolvedModel = findExactModelReferenceMatch(model, flattenModels());
if (!resolvedModel) {
	fail(
		`PI_BENCH_MODEL "${model}" did not resolve to exactly one installed model. Use an exact provider/model id reference.`,
	);
}

let validThinkingLevels;
if (!resolvedModel.reasoning) {
	validThinkingLevels = ["off"];
} else if (supportsXhigh(resolvedModel)) {
	validThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
} else {
	validThinkingLevels = ["off", "minimal", "low", "medium", "high"];
}

if (!validThinkingLevels.includes(thinking)) {
	fail(
		`PI_BENCH_THINKING "${thinking}" is invalid for model "${resolvedModel.provider}/${resolvedModel.id}". Valid values: ${validThinkingLevels.join(", ")}`,
	);
}

console.log(JSON.stringify({
	modelInput: model,
	modelResolved: `${resolvedModel.provider}/${resolvedModel.id}`,
	thinking,
	tools: requestedTools,
}, null, 2));
