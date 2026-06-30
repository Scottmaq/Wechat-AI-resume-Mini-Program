const cloud = require("wx-server-sdk");
const fs = require("fs");
const https = require("https");
const path = require("path");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const COLLECTIONS = {
  users: "users",
  results: "resume_results"
};
const UNLOCK_PRICE_FEN = 399;
const PRO_CREDITS_PER_PURCHASE = 3;

exports.main = async (event) => {
  try {
    const wxContext = cloud.getWXContext();
    const openid = wxContext.OPENID || "";
    if (!openid) {
      return {
        ok: false,
        message: "无法识别微信用户身份，请在小程序环境中重试。"
      };
    }

    const user = await getOrCreateUser(openid);
    const quota = await canUseAnalysis(openid, user);
    if (!quota.ok) return quota;

    const payload = await normalizePayload(event);
    const validation = validatePayload(payload);
    if (!validation.ok) return validation;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      if (process.env.ENABLE_DEMO_MODE !== "true") {
        return {
          ok: false,
          message: "云函数未读取到 DEEPSEEK_API_KEY。请在云函数环境变量中配置后重新部署/重启云函数。"
        };
      }

      return {
        ok: true,
        demoMode: true,
        data: await persistAndBuildResponse(openid, payload, buildDemoResult(payload), { demoMode: true, consumeCredit: quota.consumeCredit })
      };
    }

    const data = await callDeepSeek(apiKey, payload);
    const pdfResult = await createResumePdf(data, payload);
    const fullResult = {
      ...data,
      ...pdfResult
    };

    return {
      ok: true,
      demoMode: false,
      data: await persistAndBuildResponse(openid, payload, fullResult, { demoMode: false, consumeCredit: quota.consumeCredit })
    };
  } catch (error) {
    console.error("optimizeResume failed", error);
    return {
      ok: false,
      message: error.message || "AI服务暂时不可用，请稍后再试。"
    };
  }
};

async function getOrCreateUser(openid) {
  const now = new Date();
  const existing = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(1).get();
  if (existing.data && existing.data.length) return existing.data[0];

  const user = {
    _openid: openid,
    freeAnalysisUsed: false,
    proAnalysisCredits: 0,
    createdAt: now,
    updatedAt: now
  };
  const created = await db.collection(COLLECTIONS.users).add({ data: user });
  return {
    ...user,
    _id: created._id
  };
}

async function canUseAnalysis(openid, user) {
  if (!user.freeAnalysisUsed) {
    return { ok: true, consumeCredit: false };
  }

  if (Number(user.proAnalysisCredits || 0) > 0) {
    return { ok: true, consumeCredit: true };
  }

  const latestResultId = await getLatestResultId(openid);
  return {
    ok: false,
    code: "NO_ANALYSIS_QUOTA",
    latestResultId,
    message: "你的免费评估次数已用完。解锁任意一份完整简历后，可额外获得3次岗位匹配度专业分析。"
  };
}

async function getLatestResultId(openid) {
  try {
    const res = await db.collection(COLLECTIONS.results)
      .where({ _openid: openid })
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    return res.data && res.data[0] ? res.data[0]._id : "";
  } catch (error) {
    console.warn("get latest result failed", error);
    return "";
  }
}

async function persistAndBuildResponse(openid, payload, fullResult, options) {
  const now = new Date();
  const freeResult = buildFreeResult(fullResult);
  const addResult = await db.collection(COLLECTIONS.results).add({
    data: {
      _openid: openid,
      targetRole: payload.targetRole,
      mode: payload.mode,
      score: fullResult.score,
      summary: fullResult.summary,
      fullResult,
      freeResult,
      unlocked: false,
      demoMode: !!options.demoMode,
      createdAt: now,
      updatedAt: now
    }
  });

  await consumeAnalysisQuota(openid, !!options.consumeCredit);

  return {
    ...freeResult,
    resultId: addResult._id,
    targetRole: payload.targetRole,
    isUnlocked: false,
    priceFen: UNLOCK_PRICE_FEN,
    unlockPriceText: "3.99",
    proCreditsIncluded: PRO_CREDITS_PER_PURCHASE,
    demoMode: !!options.demoMode,
    createdAt: now.toISOString()
  };
}

async function consumeAnalysisQuota(openid, consumeCredit) {
  const data = {
    updatedAt: new Date()
  };
  if (consumeCredit) {
    data.proAnalysisCredits = _.inc(-1);
  } else {
    data.freeAnalysisUsed = true;
  }

  await db.collection(COLLECTIONS.users).where({ _openid: openid }).update({ data });
}

function buildFreeResult(fullResult) {
  return {
    score: fullResult.score,
    summary: fullResult.summary,
    highlights: (fullResult.highlights || []).slice(0, 2),
    gaps: (fullResult.gaps || []).slice(0, 6),
    interviewTips: [],
    optimizedResumePreview: buildLockedPreview(fullResult.optimizedResume),
    pdfNotice: "支付后可下载完整PDF简历。",
    lockedNotice: "支付3.99元后可查看完整优化简历、复制正文并下载PDF。"
  };
}

function buildLockedPreview(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "完整优化简历已生成，支付后可查看全部内容。";
  return `${value.slice(0, 90)}...`;
}

async function normalizePayload(event) {
  const mode = ["textOptimize", "pdfOptimize", "createResume"].includes(event.mode) ? event.mode : "textOptimize";
  const payload = {
    mode,
    targetRole: String(event.targetRole || "").trim().slice(0, 80),
    years: String(event.years || "").trim().slice(0, 40),
    resumeText: String(event.resumeText || "").trim().slice(0, 9000),
    jobDescription: String(event.jobDescription || "").trim().slice(0, 3000),
    sourceFileID: String(event.sourceFileID || "").trim(),
    tone: ["professional", "impact", "concise"].includes(event.tone) ? event.tone : "professional",
    profile: normalizeProfile(event.profile || {})
  };

  if (mode === "pdfOptimize") {
    payload.resumeText = await extractTextFromPdf(payload.sourceFileID);
  }

  if (mode === "createResume") {
    payload.resumeText = buildProfileText(payload.profile);
  }

  return payload;
}

function normalizeProfile(profile) {
  return {
    name: String(profile.name || "").trim().slice(0, 40),
    phone: String(profile.phone || "").trim().slice(0, 40),
    email: String(profile.email || "").trim().slice(0, 80),
    city: String(profile.city || "").trim().slice(0, 40),
    education: String(profile.education || "").trim().slice(0, 1000),
    work: String(profile.work || "").trim().slice(0, 1800),
    projects: String(profile.projects || "").trim().slice(0, 1800),
    skills: String(profile.skills || "").trim().slice(0, 1000),
    selfIntro: String(profile.selfIntro || "").trim().slice(0, 1000)
  };
}

function validatePayload(payload) {
  if (!payload.targetRole) {
    return { ok: false, message: "请填写目标岗位。" };
  }

  if (payload.mode === "pdfOptimize" && !payload.sourceFileID) {
    return { ok: false, message: "请先上传PDF简历。" };
  }

  if (payload.resumeText.length < 80) {
    return { ok: false, message: "可用简历信息至少需要80字。" };
  }

  return { ok: true };
}

async function extractTextFromPdf(fileID) {
  if (!fileID) return "";

  let pdfParse;
  try {
    pdfParse = require("pdf-parse");
  } catch (error) {
    throw new Error("云函数缺少pdf-parse依赖，请重新部署云函数并安装依赖。");
  }

  const file = await cloud.downloadFile({ fileID });
  const parsed = await pdfParse(file.fileContent);
  const text = String(parsed.text || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    throw new Error("没有从PDF中提取到文字。扫描版PDF需要先做OCR。");
  }

  return text.slice(0, 9000);
}

function buildProfileText(profile) {
  return [
    `姓名：${profile.name}`,
    `城市：${profile.city || "未填写"}`,
    `电话：${profile.phone || "未填写"}`,
    `邮箱：${profile.email || "未填写"}`,
    "",
    "教育经历：",
    profile.education || "未填写",
    "",
    "工作/实习经历：",
    profile.work || "未填写",
    "",
    "项目经历：",
    profile.projects || "未填写",
    "",
    "技能/证书：",
    profile.skills || "未填写",
    "",
    "补充信息：",
    profile.selfIntro || "未填写"
  ].join("\n");
}

async function callDeepSeek(apiKey, payload) {
  const model = payload.mode === "pdfOptimize"
    ? (process.env.DEEPSEEK_PDF_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro")
    : (process.env.DEEPSEEK_MODEL || "deepseek-v4-pro");
  const reasoningEffort = payload.mode === "pdfOptimize"
    ? (process.env.DEEPSEEK_PDF_REASONING_EFFORT || "high")
    : (process.env.DEEPSEEK_REASONING_EFFORT || "high");
  const thinkingMode = getThinkingMode(payload.mode);
  const requestBody = {
    model,
    messages: [
      {
        role: "system",
        content: payload.mode === "pdfOptimize" ? buildFastPdfSystemPrompt() : buildSystemPrompt()
      },
      {
        role: "user",
        content: payload.mode === "pdfOptimize" ? buildFastPdfPrompt(payload) : buildPrompt(payload)
      }
    ],
    stream: false,
    max_tokens: payload.mode === "pdfOptimize" ? 3200 : 3000,
    response_format: {
      type: "json_object"
    },
    thinking: {
      type: thinkingMode
    }
  };

  if (thinkingMode === "enabled") {
    requestBody.reasoning_effort = reasoningEffort;
  }

  const startedAt = Date.now();
  const response = await postJson("api.deepseek.com", "/chat/completions", requestBody, {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  });
  console.log("DeepSeek completed", {
    mode: payload.mode,
    model,
    thinking: thinkingMode,
    elapsedMs: Date.now() - startedAt
  });

  if (response.error) {
    throw new Error(response.error.message || "DeepSeek API error");
  }

  const choice = response.choices && response.choices[0] ? response.choices[0] : {};
  const message = choice.message || {};
  const content = extractDeepSeekContent(message);

  if (!content) {
    console.error("DeepSeek returned empty content", {
      mode: payload.mode,
      finishReason: choice.finish_reason || "",
      messageKeys: Object.keys(message),
      hasReasoningContent: !!message.reasoning_content,
      reasoningLength: message.reasoning_content ? String(message.reasoning_content).length : 0
    });

    if (payload.mode === "pdfOptimize") {
      return buildFallbackAiResult(payload);
    }

    throw new Error("DeepSeek没有返回可解析文本。");
  }

  return parseJsonFromText(content, payload);
}

function getThinkingMode(mode) {
  const modeValue = mode === "pdfOptimize" ? process.env.DEEPSEEK_PDF_THINKING : "";
  const value = modeValue || process.env.DEEPSEEK_THINKING || "disabled";
  return value === "enabled" ? "enabled" : "disabled";
}

function extractDeepSeekContent(message) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && typeof item.content === "string") return item.content;
      return "";
    }).join("").trim();
  }
  return "";
}

function buildFastPdfSystemPrompt() {
  return [
    "You are a senior resume editor who prepares final, recruiter-ready one-page resumes for finance, consulting, product, data, operations, and technology roles.",
    "Return JSON only. Do not include markdown or explanations.",
    "Preserve the original resume language. If the source resume is mostly English, output English. If it is mostly Chinese, output Chinese. Do not translate an English resume into Chinese.",
    "Do not fabricate facts, companies, schools, dates, titles, metrics, or certificates.",
    "Prioritize fidelity, specificity, and selectivity: rewrite weak wording, keep the candidate's strongest original facts, and remove low-value filler.",
    "Every resume bullet must read like a real resume bullet, not an AI summary. Prefer action + scope/method + result/evidence.",
    "The PDF target is one-page A4, but never over-compress into vague generic bullets."
  ].join("\n");
}

function buildSystemPrompt() {
  return [
    "你是资深求职简历顾问，擅长把用户经历整理成真实、清晰、结果导向、可投递的最终版简历。",
    "你尤其擅长投行、咨询、互联网、数据分析、产品、运营等岗位的一页制简历。",
    "不要编造公司、学历、证书、项目数据。缺少量化结果时，用“可补充：...”提示。",
    "简历正文必须保留用户原始经历中的具体业务、工具、方法、行业、项目范围和已有指标，不能改成空泛套话。",
    "每条经历 bullet 优先采用“动作 + 范围/方法 + 结果/证据”的结构；没有结果数据时也要保留可核验的事实细节。",
    "只返回JSON对象，不要返回Markdown代码块、解释文字或多余前后缀。",
    "生成给候选人直接投递的简历，不要写AI、AI优化、机器生成等字样。"
  ].join("\n");
}

function buildFastPdfPrompt(payload) {
  const sourceText = payload.resumeText.slice(0, 8500);
  const jdText = payload.jobDescription.slice(0, 1600);

  return [
    `Target role: ${payload.targetRole}`,
    `Years of experience: ${payload.years || "not provided"}`,
    "",
    "Source resume text extracted from PDF:",
    sourceText,
    "",
    "Target JD, optional:",
    jdText || "not provided",
    "",
    "Return only this JSON. Keep field names exactly the same:",
    JSON.stringify({
      score: 80,
      summary: "One concise sentence about role fit, in the same language as the source resume.",
      optimizedResume: "A complete polished resume text in the same language as the source resume.",
      highlights: ["specific strength 1", "specific strength 2", "specific strength 3"],
      gaps: ["specific gap 1", "specific gap 2", "specific gap 3"],
      interviewTips: ["interview prep 1", "interview prep 2", "interview prep 3"],
      structuredResume: {
        name: "",
        contactLine: "phone | email | city",
        education: [
          {
            organization: "school",
            location: "city",
            title: "degree / major",
            date: "date",
            bullets: ["honors, grade, relevant programs, or coursework"]
          }
        ],
        experience: [
          {
            organization: "company / project",
            location: "city",
            title: "role",
            date: "date",
            bullets: ["specific action + method + outcome", "specific scope/tool + evidence", "specific business relevance or result"]
          }
        ],
        leadership: [],
        skills: ["Languages: ...", "Technical: ...", "Certifications: ...", "Interests: ..."]
      }
    }),
    "",
    "Quality rules:",
    "1. Preserve original language and proper nouns exactly where possible.",
    "2. For finance/IBD resumes, keep finance terms such as DCF, LBO, M&A, comparable companies, precedent transactions, market research, portfolio return, A-shares, Python strategies.",
    "3. Keep the original resume's strongest substance. Do not replace detailed finance/product/data/project facts with generic soft-skill claims.",
    "4. Experience should include 3-5 strongest professional/research/project entries, ordered by relevance and recency.",
    "5. Leadership can include up to 2 strongest extracurricular/leadership entries.",
    "6. Each experience bullet must be concrete and fact-based. Avoid generic wording like 'improved collaboration' unless the source supports it.",
    "7. Write with a stronger, more senior resume voice: elevate responsibilities, methods, tools, and business relevance from the source facts, but do not invent employers, dates, tools, metrics, awards, or outcomes.",
    "8. One-page target means fill about 80-95% of one A4 page, not half a page. Strong internships/projects should usually have 2-3 bullets; weak or low-relevance entries can have 1 bullet.",
    "9. Each bullet should be under 36 English words or 95 Chinese characters. Prefer rich, specific bullets over short generic bullets.",
    "10. Skills must be grouped into short labelled rows, for example 'Languages: ...', 'Technical: ...', 'Certifications: ...', 'Interests: ...'. Do not combine all groups into one crowded sentence.",
    "11. Do not use placeholders such as '可补充', 'to be added', 'not provided', or bracketed guesses inside structuredResume.",
    "12. If data is missing, leave the field empty rather than inventing it.",
    "13. Keep weaknesses, missing experience, and improvement suggestions only in gaps. Never write candidate weaknesses inside structuredResume or optimizedResume.",
    "14. optimizedResume should mirror structuredResume and be ready to copy directly."
  ].join("\n");
}

function buildPrompt(payload) {
  const toneLabel = {
    professional: "专业稳重",
    impact: "结果导向，突出业务影响",
    concise: "简洁清晰，减少空话"
  }[payload.tone];

  const modeLabel = {
    textOptimize: "用户粘贴了已有简历文本，需要优化。",
    pdfOptimize: "用户上传了PDF简历，以下内容来自PDF文字提取，需要基于原内容优化。",
    createResume: "用户当前没有完整简历，需要根据问答信息创建一份可投递简历。"
  }[payload.mode];

  return [
    modeLabel,
    `目标岗位：${payload.targetRole}`,
    `工作年限：${payload.years || "未填写"}`,
    `表达风格：${toneLabel}`,
    "",
    "用户提供的信息：",
    payload.resumeText,
    "",
    "目标JD / 招聘要求：",
    payload.jobDescription || "未提供",
    "",
    "请返回一页简历需要的数据。目标是填满一页A4的80%-95%，不要只生成半页。",
    "经历取舍原则：优先保留与目标岗位最相关、最有量化结果、最能证明能力的内容。",
    "不要把原简历里的行业术语、工具、项目背景、研究方法、交易/产品/数据细节删成泛泛而谈。",
    "可以把表达写得更专业、更有商业价值，但只能基于用户提供的事实展开；不要新编公司、日期、工具、指标、奖项、证书或成果。",
    "每条bullet控制在110个中文字符或180个英文字符以内；核心实习/项目通常写2-3条bullet，弱相关经历才写1条；总经历最多5段。",
    "如果内容过多，主动压缩、合并、删弱项；如果内容偏少，要把已有经历中的职责、方法、工具、分析对象、产出用途写充分。",
    "",
    "请严格返回以下JSON结构：",
    JSON.stringify({
      score: 85,
      summary: "岗位匹配摘要，中文一段话。",
      optimizedResume: "可直接投递的完整中文简历文本。",
      highlights: ["亮点1", "亮点2", "亮点3"],
      gaps: ["需要补充1", "需要补充2", "需要补充3"],
      interviewTips: ["面试准备1", "面试准备2", "面试准备3"],
      structuredResume: {
        name: "候选人姓名",
        contactLine: "电话 | 邮箱 | 城市 | 作品集/LinkedIn",
        education: [
          {
            organization: "学校名称",
            location: "城市，国家",
            title: "学历/专业",
            date: "时间",
            bullets: ["成绩、荣誉、相关课程或项目"]
          }
        ],
        experience: [
          {
            organization: "公司/组织",
            location: "城市，国家",
            title: "岗位/角色",
            date: "时间",
            bullets: ["结果导向bullet", "方法/工具/范围bullet", "业务价值或产出bullet"]
          }
        ],
        leadership: [
          {
            organization: "组织/项目",
            location: "城市",
            title: "角色",
            date: "时间",
            bullets: ["简短bullet"]
          }
        ],
        skills: ["语言：...", "技能：...", "证书：...", "兴趣：..."]
      }
    }, null, 2),
    "",
    "字段要求：",
    "1. score必须是1到100之间的整数。",
    "2. optimizedResume供页面展示，可以完整一些。",
    "3. structuredResume供PDF排版，必须具体、有分量，目标是填满一页但不超过一页。",
    "4. structuredResume.name如果能从用户内容识别就填写真实姓名，否则写空字符串。",
    "5. skills必须拆成短标签行，例如“语言：...”“技能：...”“证书：...”“兴趣：...”，不要把所有技能和兴趣挤在一个长句里。",
    "6. 不确定的信息不要编造；可补充项和短板只能放在gaps里，不要放进structuredResume或optimizedResume。",
    "7. 可投递简历正文只能使用正向、专业的候选人定位，不要在正文里写“缺少、没有、不足、建议补充”等评价语。"
  ].join("\n");
}

function postJson(hostname, requestPath, body, headers) {
  const payload = JSON.stringify(body);
  const timeoutMs = Number.parseInt(process.env.DEEPSEEK_HTTP_TIMEOUT_MS || "150000", 10);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: requestPath,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode >= 400) {
              reject(new Error(parsed.error && parsed.error.message ? parsed.error.message : raw));
              return;
            }
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(Number.isNaN(timeoutMs) ? 150000 : timeoutMs, () => {
      req.destroy(new Error("DeepSeek API 请求超时，请降低模型思考强度或调高云函数 timeout。"));
    });
    req.write(payload);
    req.end();
  });
}

function parseJsonFromText(text, payload) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return normalizeAiResult(JSON.parse(cleaned), payload);
  } catch (error) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("AI返回内容不是有效JSON。");
    }
    return normalizeAiResult(JSON.parse(cleaned.slice(start, end + 1)), payload);
  }
}

function normalizeAiResult(value, payload) {
  const result = {
    score: clampScore(value.score),
    summary: String(value.summary || "已生成简历优化结果。").trim(),
    optimizedResume: String(value.optimizedResume || "").trim(),
    highlights: normalizeStringList(value.highlights),
    gaps: normalizeStringList(value.gaps),
    interviewTips: normalizeStringList(value.interviewTips),
    structuredResume: normalizeStructuredResume(value.structuredResume, payload)
  };

  if (!result.optimizedResume) {
    result.optimizedResume = structuredToText(result.structuredResume);
  }

  return result;
}

function buildFallbackAiResult(payload) {
  const structuredResume = buildFallbackStructuredResume(payload);
  return {
    score: payload.jobDescription ? 70 : 62,
    summary: "DeepSeek本次没有返回正文，已根据PDF提取文本生成基础版一页简历。建议稍后重试以获得更强的AI改写效果。",
    optimizedResume: structuredToText(structuredResume),
    highlights: [
      "已从PDF提取文本并生成一页简历结构。",
      "已保留可识别的教育、经历和技能信息。",
      "已按紧凑模板生成可预览PDF。"
    ],
    gaps: [
      "建议补充更明确的量化成果。",
      "建议补充岗位相关关键词。",
      "建议稍后重试以获得更完整的AI润色版本。"
    ],
    interviewTips: [
      "准备一段最相关经历的背景、行动和结果。",
      "提前解释简历中每段经历与目标岗位的关系。",
      "补充能证明能力的数据或作品链接。"
    ],
    structuredResume
  };
}

function buildFallbackStructuredResume(payload) {
  const lines = String(payload.resumeText || "")
    .split(/\n/)
    .map((line) => cleanText(line, 180))
    .filter(Boolean);
  const contactLine = extractContactLine(lines) || buildContactLine(payload);
  const name = payload.profile.name || extractLikelyName(payload.resumeText) || "";
  const educationLines = pickLines(lines, /(university|college|school|bachelor|master|phd|degree|教育|大学|学院|本科|硕士|博士)/i, 3);
  const skillLines = pickLines(lines, /(skills|languages|python|java|excel|sql|技能|语言|证书|工具)/i, 2);
  const experienceLines = lines
    .filter((line) => !educationLines.includes(line) && !skillLines.includes(line))
    .filter((line) => line.length >= 12)
    .slice(0, 8);

  return {
    name,
    contactLine,
    education: educationLines.length ? [
      {
        organization: educationLines[0],
        location: "",
        title: educationLines[1] || "",
        date: "",
        bullets: educationLines.slice(2, 3)
      }
    ] : [],
    experience: chunkFallbackExperience(experienceLines, payload.targetRole),
    leadership: [],
    skills: skillLines.length ? skillLines.slice(0, 2) : []
  };
}

function extractContactLine(lines) {
  const contacts = lines.filter((line) => /@|\+?\d[\d\s-]{6,}/.test(line)).slice(0, 2);
  return contacts.join(" | ");
}

function pickLines(lines, pattern, limit) {
  return lines.filter((line) => pattern.test(line)).slice(0, limit);
}

function chunkFallbackExperience(lines, targetRole) {
  const chunks = [];
  for (let index = 0; index < lines.length && chunks.length < 3; index += 3) {
    const head = lines[index] || `${targetRole} Experience`;
    chunks.push({
      organization: head,
      location: "",
      title: lines[index + 1] || targetRole,
      date: "",
      bullets: lines.slice(index + 2, index + 4).map((line) => cleanText(line, 150)).slice(0, 2)
    });
  }
  return chunks;
}

function clampScore(value) {
  const score = Number.parseInt(value, 10);
  if (Number.isNaN(score)) return 70;
  return Math.max(1, Math.min(100, score));
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6);
}

function normalizeStructuredResume(value, payload) {
  const source = value && typeof value === "object" ? value : {};
  return {
    name: cleanText(source.name || payload.profile.name || extractLikelyName(payload.resumeText), 60),
    contactLine: cleanText(source.contactLine || buildContactLine(payload), 180),
    education: normalizeEntries(source.education, 2, 2),
    experience: normalizeEntries(source.experience, 5, 3),
    leadership: normalizeEntries(source.leadership, 2, 2),
    skills: normalizeStringList(source.skills)
      .map((item) => cleanText(item, 180))
      .filter((item) => item && !isPlaceholderText(item))
      .slice(0, 4)
  };
}

function normalizeEntries(entries, maxEntries, maxBullets) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    organization: cleanText(entry.organization, 90),
    location: cleanText(entry.location, 70),
    title: cleanText(entry.title, 100),
    date: cleanText(entry.date, 60),
    bullets: normalizeStringList(entry.bullets)
      .map((item) => cleanBullet(item))
      .filter(Boolean)
      .slice(0, maxBullets)
  })).filter((entry) => entry.organization || entry.title || entry.bullets.length).slice(0, maxEntries);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/AI优化简历|AI 优化简历|AI生成|AI 生成/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanBullet(value) {
  const text = cleanText(value, 260)
    .replace(/^[-•·*]\s*/, "")
    .trim();
  if (!text || isPlaceholderText(text)) return "";
  return text;
}

function isPlaceholderText(value) {
  return /(可补充|待补充|未提供|未填写|not provided|to be added|tbd|\[[^\]]+\])/.test(String(value || "").toLowerCase());
}

function buildContactLine(payload) {
  const parts = [payload.profile.phone, payload.profile.email, payload.profile.city].filter(Boolean);
  return parts.join(" | ");
}

function extractLikelyName(text) {
  const lines = String(text || "").split(/\n/).map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => line.length <= 40 && !/[：:|]/.test(line));
  return first || "";
}

function structuredToText(resume) {
  const titles = getResumeSectionTitles(detectResumeLanguage(resume));
  const parts = [];
  if (resume.name) parts.push(resume.name);
  if (resume.contactLine) parts.push(resume.contactLine);
  appendTextSection(parts, titles.education, resume.education);
  appendTextSection(parts, titles.experience, resume.experience);
  appendTextSection(parts, titles.leadership, resume.leadership);
  if (resume.skills.length) {
    parts.push(titles.skills);
    parts.push(...resume.skills);
  }
  return parts.join("\n");
}

function appendTextSection(parts, title, entries) {
  if (!entries.length) return;
  parts.push("", title);
  for (const entry of entries) {
    parts.push([entry.organization, entry.location].filter(Boolean).join(" | "));
    parts.push([entry.title, entry.date].filter(Boolean).join(" | "));
    for (const bullet of entry.bullets) parts.push(`- ${bullet}`);
  }
}

async function createResumePdf(data, payload) {
  const fontPath = findFontPath();
  if (!fontPath) {
    return {
      pdfFileID: "",
      pdfNotice: "云函数未找到中文字体，已生成文本结果。请把otf/ttf字体放到assets目录后重新部署。"
    };
  }

  let PDFDocument;
  try {
    PDFDocument = require("pdfkit");
  } catch (error) {
    return {
      pdfFileID: "",
      pdfNotice: "云函数缺少pdfkit依赖，请重新部署云函数并安装依赖。"
    };
  }

  const buffer = await renderPdfBuffer(PDFDocument, fontPath, data, payload);
  const cloudPath = `generated-resumes/${Date.now()}-${safeFileName(payload.targetRole)}.pdf`;
  const upload = await cloud.uploadFile({
    cloudPath,
    fileContent: buffer
  });

  return {
    pdfFileID: upload.fileID,
    pdfNotice: ""
  };
}

function findFontPath() {
  const assetsDir = path.join(__dirname, "assets");
  const candidates = [
    path.join(assetsDir, "resume-font.ttf"),
    path.join(assetsDir, "resume-font.otf"),
    process.env.RESUME_FONT_PATH || ""
  ].filter(Boolean);

  if (fs.existsSync(assetsDir)) {
    const detectedFonts = fs.readdirSync(assetsDir)
      .filter((name) => /\.(ttf|otf)$/i.test(name))
      .map((name) => path.join(assetsDir, name));
    candidates.push(...detectedFonts);
  }

  return candidates.find((item) => item && fs.existsSync(item)) || "";
}

function renderPdfBuffer(PDFDocument, fontPath, data, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: "A4",
      autoFirstPage: false,
      info: {
        Title: `${payload.targetRole} Resume`,
        Author: ""
      }
    });

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("ResumeFont", fontPath);
    doc.font("ResumeFont");
    doc.addPage({
      size: "A4",
      margins: {
        top: 34,
        bottom: 32,
        left: 44,
        right: 44
      }
    });

    renderOnePageResume(doc, data.structuredResume || normalizeStructuredResume(null, payload), data.summary);
    doc.end();
  });
}

function renderOnePageResume(doc, resume, summary) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const language = detectResumeLanguage(resume);
  const titles = getResumeSectionTitles(language);
  const density = estimateResumeDensity(resume);
  const layout = getPdfLayout(density);

  doc.font("ResumeFont").fillColor("#111827");
  doc.fontSize(layout.nameSize).text(resume.name || "Candidate", left, doc.y, {
    width,
    align: "center",
    lineGap: 0.4
  });
  doc.y += layout.headerGap;

  if (resume.contactLine) {
    doc.fontSize(layout.contactSize).fillColor("#475467").text(resume.contactLine, left, doc.y, {
      width,
      align: "center",
      lineGap: 0.3
    });
    doc.y += layout.afterContactGap;
  }

  const profileSummary = buildPositiveProfileSummary(resume, summary);
  if (density < 2500 && profileSummary) {
    writeSummarySection(doc, titles.summary, profileSummary, { left, right, width, bottom }, layout);
  }

  writeTemplateSection(doc, titles.education, resume.education, { left, right, width, bottom }, layout);
  writeTemplateSection(doc, titles.experience, resume.experience, { left, right, width, bottom }, layout);
  writeTemplateSection(doc, titles.leadership, resume.leadership, { left, right, width, bottom }, layout);
  writeSkillsSection(doc, titles.skills, resume.skills, { left, right, width, bottom }, layout);
}

function writeSummarySection(doc, title, summary, box, layout) {
  const text = cleanText(summary, 220);
  if (!text || doc.y > box.bottom - 42) return;

  drawSectionTitle(doc, title, box, layout);
  const options = {
    width: box.width,
    lineGap: layout.summaryLineGap
  };
  doc.fontSize(layout.summarySize).fillColor("#24364B");
  const height = doc.heightOfString(text, options);
  if (doc.y + height > box.bottom) return;
  doc.text(text, box.left, doc.y, options);
  doc.y += layout.summaryGap;
  doc.fillColor("#111827");
}

function buildPositiveProfileSummary(resume, fallbackSummary) {
  const language = detectResumeLanguage(resume);
  const primaryExperience = (resume.experience || []).find((entry) => entry.title || entry.organization);
  const education = (resume.education || [])[0] || {};
  const skillText = (resume.skills || []).join("; ");
  const educationText = [education.organization, education.title].filter(Boolean).join(language === "zh" ? "，" : ", ");
  const experienceText = primaryExperience
    ? [primaryExperience.organization, primaryExperience.title].filter(Boolean).join(language === "zh" ? "，" : ", ")
    : "";
  const skills = extractPositiveSkillKeywords(skillText).slice(0, 4);

  if (language === "zh") {
    const parts = [];
    if (educationText) parts.push(educationText);
    if (experienceText) parts.push(`${experienceText}经历`);
    if (skills.length) parts.push(`${skills.join("、")}相关能力`);
    if (parts.length) return `${parts.join("；")}。`;
  } else {
    const parts = [];
    if (educationText) parts.push(educationText);
    if (experienceText) parts.push(`${experienceText} experience`);
    if (skills.length) parts.push(`${skills.join(", ")} capabilities`);
    if (parts.length) return `${parts.join("; ")}.`;
  }

  const cleaned = cleanText(fallbackSummary, 180);
  if (!cleaned || isNegativeProfileText(cleaned)) return "";
  return cleaned;
}

function extractPositiveSkillKeywords(text) {
  const matches = String(text || "").match(/Python|SQL|Excel|Power BI|Tableau|Java|C\+\+|R\b|DCF|LBO|M&A|机器学习|数据分析|财务建模|市场研究|用户增长|产品分析/gi);
  return Array.from(new Set(matches || []));
}

function isNegativeProfileText(text) {
  return /(缺少|欠缺|不足|没有|无任何|无法|建议|需要|待补充|不匹配|weak|lack|missing|insufficient|no relevant)/i.test(String(text || ""));
}

function writeTemplateSection(doc, title, entries, box, layout) {
  if (!entries || !entries.length || doc.y > box.bottom - 34) return;

  drawSectionTitle(doc, title, box, layout);

  for (const entry of entries) {
    if (doc.y > box.bottom - layout.entryReserve) return;
    writeEntryLine(doc, entry.organization, entry.location, box, layout.orgSize, true, layout);
    writeEntryLine(doc, entry.title, entry.date, box, layout.metaSize, false, layout);

    for (const bullet of entry.bullets || []) {
      if (doc.y > box.bottom - 20) return;
      writeBullet(doc, bullet, box, layout);
    }
    doc.y += layout.entryGap;
  }
}

function drawSectionTitle(doc, title, box, layout) {
  doc.y += layout.sectionTopGap;
  const y = doc.y;
  const text = cleanText(title, 80).toUpperCase();
  doc.fontSize(layout.sectionSize).fillColor("#0F3D5E");
  const height = doc.heightOfString(text, {
    width: box.width,
    lineGap: 0
  });
  drawPdfText(doc, text, box.left, y, {
    width: box.width,
    lineGap: 0
  }, true);
  const lineY = y + height + 1.8;
  doc.moveTo(box.left, lineY).lineTo(box.right, lineY).strokeColor("#7A8CA5").lineWidth(0.65).stroke();
  doc.y = lineY + layout.sectionBottomGap;
  doc.fillColor("#111827");
}

function writeEntryLine(doc, leftText, rightText, box, fontSize, boldLike, layout) {
  const leftValue = cleanText(leftText, 130);
  const rightValue = cleanText(rightText, 90);
  if (!leftValue && !rightValue) return;

  const rightWidth = 148;
  const leftWidth = box.width - rightWidth - 12;
  const y = doc.y;
  const leftOptions = {
    width: leftWidth,
    lineGap: 0.3
  };
  const rightOptions = {
    width: rightWidth,
    align: "right",
    lineGap: 0.3
  };

  doc.fontSize(fontSize).fillColor(boldLike ? "#0B1220" : "#344054");
  const leftHeight = leftValue ? doc.heightOfString(leftValue, leftOptions) : 0;
  const rightHeight = rightValue ? doc.heightOfString(rightValue, rightOptions) : 0;
  if (leftValue) drawPdfText(doc, leftValue, box.left, y, leftOptions, boldLike);
  if (rightValue) drawPdfText(doc, rightValue, box.right - rightWidth, y, rightOptions, false);
  doc.y = y + Math.max(leftHeight, rightHeight, fontSize + 1.8) + layout.entryLineGap;
}

function writeBullet(doc, bullet, box, layout) {
  const markerWidth = 10;
  const text = cleanBullet(bullet);
  if (!text) return;
  const y = doc.y;
  const options = {
    width: box.width - markerWidth,
    lineGap: layout.bulletLineGap
  };
  doc.fontSize(layout.bulletSize).fillColor("#111827");
  const height = doc.heightOfString(text, options);
  if (y + height > box.bottom) return;

  doc.fillColor("#0F5592").text("•", box.left + 1, y, { width: markerWidth });
  doc.fillColor("#111827");
  drawPdfText(doc, text, box.left + markerWidth, y, options, shouldEmphasizeBullet(text));
  doc.y = y + height + layout.bulletGap;
}

function writeSkillsSection(doc, title, skills, box, layout) {
  if (!skills || !skills.length || doc.y > box.bottom - 30) return;
  drawSectionTitle(doc, title, box, layout);
  for (const row of normalizeSkillRows(skills)) {
    if (doc.y > box.bottom - 16) return;
    if (!writeSkillRow(doc, row, box, layout)) return;
  }
}

function normalizeSkillRows(skills) {
  const rows = [];
  for (const skill of skills || []) {
    const text = cleanText(skill, 240);
    if (!text) continue;
    const parts = text.split(/\s*;\s*/).map((item) => item.trim()).filter(Boolean);
    for (const part of parts.length ? parts : [text]) {
      const match = part.match(/^([^:：]{2,28})[:：]\s*(.+)$/);
      if (match) {
        rows.push({
          label: cleanText(match[1], 32),
          value: cleanText(match[2], 190)
        });
      } else {
        rows.push({
          label: "",
          value: cleanText(part, 220)
        });
      }
    }
  }
  return rows.filter((row) => row.value).slice(0, 6);
}

function writeSkillRow(doc, row, box, layout) {
  const y = doc.y;
  doc.fontSize(layout.skillSize);

  if (!row.label) {
    const options = {
      width: box.width,
      lineGap: layout.skillLineGap
    };
    const height = doc.heightOfString(row.value, options);
    if (y + height > box.bottom) return false;
    doc.fillColor("#111827").text(row.value, box.left, y, options);
    doc.y = y + height + layout.skillGap;
    return true;
  }

  const label = `${row.label}:`;
  const labelWidth = Math.min(92, Math.max(48, doc.widthOfString(label) + 8));
  const valueOptions = {
    width: box.width - labelWidth,
    lineGap: layout.skillLineGap
  };
  const height = Math.max(
    doc.heightOfString(label, { width: labelWidth, lineGap: 0 }),
    doc.heightOfString(row.value, valueOptions)
  );
  if (y + height > box.bottom) return false;

  doc.fillColor("#0B1220");
  drawPdfText(doc, label, box.left, y, {
    width: labelWidth,
    lineGap: 0
  }, true);
  doc.fillColor("#111827").text(row.value, box.left + labelWidth, y, valueOptions);
  doc.y = y + height + layout.skillGap;
  return true;
}

function drawPdfText(doc, text, x, y, options, fauxBold) {
  doc.text(text, x, y, options);
  if (fauxBold) {
    doc.text(text, x + 0.16, y, options);
  }
}

function shouldEmphasizeBullet(text) {
  return /(%|£|\$|¥|\b\d+(?:\.\d+)?\b|\bDCF\b|\bLBO\b|\bM&A\b|\bPython\b|\bSQL\b|\bJava\b|\bA-shares\b)/i.test(text);
}

function detectResumeLanguage(resume) {
  const text = collectResumeText(resume);
  const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (text.match(/[a-z]/gi) || []).length;
  return cjkCount > 0 && cjkCount >= latinCount * 0.18 ? "zh" : "en";
}

function collectResumeText(resume) {
  const parts = [resume.name, resume.contactLine].filter(Boolean);
  for (const section of [resume.education, resume.experience, resume.leadership]) {
    for (const entry of section || []) {
      parts.push(entry.organization, entry.location, entry.title, entry.date, ...(entry.bullets || []));
    }
  }
  parts.push(...(resume.skills || []));
  return parts.filter(Boolean).join(" ");
}

function getResumeSectionTitles(language) {
  if (language === "zh") {
    return {
      summary: "个人优势",
      education: "教育背景",
      experience: "工作与项目经历",
      leadership: "领导力与课外经历",
      skills: "技能与证书"
    };
  }
  return {
    summary: "Profile",
    education: "Education",
    experience: "Professional & Project Experience",
    leadership: "Leadership & Activities",
    skills: "Skills & Certifications"
  };
}

function estimateResumeDensity(resume) {
  const textLength = collectResumeText(resume).length;
  const entryCount = [
    ...(resume.education || []),
    ...(resume.experience || []),
    ...(resume.leadership || [])
  ].length;
  const bulletCount = [
    ...(resume.education || []),
    ...(resume.experience || []),
    ...(resume.leadership || [])
  ].reduce((sum, entry) => sum + (entry.bullets || []).length, 0);
  return textLength + entryCount * 80 + bulletCount * 35;
}

function getPdfLayout(density) {
  if (density > 3100) {
    return {
      nameSize: 15.4,
      contactSize: 8,
      sectionSize: 8.7,
      summarySize: 8.1,
      orgSize: 8.5,
      metaSize: 8.1,
      bulletSize: 8,
      skillSize: 8,
      headerGap: 2.4,
      afterContactGap: 7,
      sectionTopGap: 5,
      sectionBottomGap: 4.2,
      summaryLineGap: 0.6,
      summaryGap: 4,
      entryLineGap: 1,
      entryGap: 2.4,
      bulletLineGap: 0.4,
      bulletGap: 1.7,
      skillLineGap: 0.4,
      skillGap: 1.2,
      entryReserve: 38
    };
  }

  if (density > 2300) {
    return {
      nameSize: 16.2,
      contactSize: 8.3,
      sectionSize: 9,
      summarySize: 8.5,
      orgSize: 8.8,
      metaSize: 8.4,
      bulletSize: 8.3,
      skillSize: 8.3,
      headerGap: 2.8,
      afterContactGap: 8,
      sectionTopGap: 5.4,
      sectionBottomGap: 4.6,
      summaryLineGap: 0.8,
      summaryGap: 4.8,
      entryLineGap: 1.2,
      entryGap: 2.8,
      bulletLineGap: 0.5,
      bulletGap: 1.9,
      skillLineGap: 0.5,
      skillGap: 1.4,
      entryReserve: 40
    };
  }

  return {
    nameSize: 18.4,
    contactSize: 9.2,
    sectionSize: 9.8,
    summarySize: 8.9,
    orgSize: 9.5,
    metaSize: 9,
    bulletSize: 8.9,
    skillSize: 8.9,
    headerGap: 3.8,
    afterContactGap: 11,
    sectionTopGap: 7.2,
    sectionBottomGap: 5.8,
    summaryLineGap: 1,
    summaryGap: 5.6,
    entryLineGap: 1.7,
    entryGap: 4,
    bulletLineGap: 0.8,
    bulletGap: 2.8,
    skillLineGap: 0.8,
    skillGap: 2,
    entryReserve: 44
  };
}

function safeFileName(value) {
  return String(value || "resume").replace(/[^\w.-]/g, "_").slice(0, 40) || "resume";
}

function buildDemoResult(payload) {
  const role = payload.targetRole;
  const structuredResume = {
    name: payload.profile.name || "Candidate Name",
    contactLine: buildContactLine(payload) || "Phone | Email | City",
    education: [
      {
        organization: "University / School",
        location: "City",
        title: "Degree / Major",
        date: "Date",
        bullets: ["Relevant coursework, honors, or projects."]
      }
    ],
    experience: [
      {
        organization: "Company / Project",
        location: "City",
        title: role,
        date: "Date",
        bullets: [
          "Delivered a role-relevant project, improving execution quality and stakeholder alignment.",
          "可补充：量化成果、覆盖用户、收入影响、效率提升或成本节省。"
        ]
      }
    ],
    leadership: [],
    skills: ["Skills: Tools, languages, certifications, and domain knowledge."]
  };

  return {
    score: payload.jobDescription ? 80 : 72,
    summary: "这是演示结果。配置DEEPSEEK_API_KEY后，会基于真实内容生成一页简历和PDF文件。",
    optimizedResume: structuredToText(structuredResume),
    highlights: [
      "将经历从职责描述改为结果导向表达。",
      "围绕目标岗位强化关键词匹配。",
      "保留事实边界，避免虚构项目数据。"
    ],
    gaps: [
      "建议补充2-3个可量化结果。",
      "建议补充使用过的工具、技术栈或业务系统。",
      "建议把最近一段经历写得更具体。"
    ],
    interviewTips: [
      "准备一个最能体现岗位能力的项目案例。",
      "用背景、行动、结果的结构讲清楚贡献。",
      "提前准备对目标岗位要求的理解。"
    ],
    structuredResume,
    pdfFileID: "",
    pdfNotice: "演示模式不会生成云端PDF。"
  };
}
