const app = getApp();

Page({
  data: {
    mode: "paste",
    modes: [
      { label: "优化文本", value: "paste" },
      { label: "上传PDF", value: "pdf" },
      { label: "帮我写", value: "create" }
    ],
    targetRole: "",
    years: "",
    resumeText: "",
    jobDescription: "",
    tone: "professional",
    tones: [
      { label: "专业", value: "professional" },
      { label: "结果导向", value: "impact" },
      { label: "简洁", value: "concise" }
    ],
    pdfFile: null,
    pdfFileID: "",
    profile: {
      name: "",
      phone: "",
      email: "",
      city: "",
      education: "",
      work: "",
      projects: "",
      skills: "",
      selfIntro: ""
    },
    loading: false,
    uploading: false,
    submitText: "开始处理",
    quota: {
      freeRemaining: "--",
      proRemaining: "--",
      totalRemaining: "--"
    },
    progress: 0,
    loadingStepText: "",
    loadingSteps: [
      "正在读取简历信息",
      "AI正在分析岗位匹配",
      "正在重写项目经历",
      "正在整理亮点与缺口",
      "正在生成可投递版本",
      "正在准备PDF简历"
    ],
    trustItems: [
      {
        icon: "AI",
        title: "岗位语义匹配",
        desc: "结合目标JD识别关键词、能力模型和经历优先级，减少泛泛而谈。"
      },
      {
        icon: "PDF",
        title: "一页制排版引擎",
        desc: "根据内容密度动态调整字号、行距和分区，生成适合投递的PDF。"
      },
      {
        icon: "DATA",
        title: "事实边界控制",
        desc: "强化表达但不虚构公司、日期、证书和指标，保留可核验经历。"
      },
      {
        icon: "ATS",
        title: "关键词结构优化",
        desc: "围绕岗位要求整理项目、技能和成果表达，兼顾HR浏览和系统筛选。"
      }
    ],
    testimonials: [
      {
        role: "应届生 · 数据分析方向",
        quote: "我原来的项目经历写得很像课程报告，优化后会把数据清洗、建模和业务结论分开写，读起来顺很多。",
        result: "项目表达更清楚"
      },
      {
        role: "转行求职 · 产品运营",
        quote: "我只填了比较零散的经历，它帮我把活动复盘、用户增长和数据分析串起来了，后面自己再改就轻松很多。",
        result: "更好下手修改"
      },
      {
        role: "留学生 · 金融实习",
        quote: "英文简历上传后没有被硬翻译，DCF、LBO和market research这些词也保留住了，这点比我之前用的工具舒服。",
        result: "术语保留更稳"
      },
      {
        role: "本科生 · 前端开发",
        quote: "最有用的是它会把我写得很散的项目职责整理成几条重点，还会提醒哪些地方最好补数据。",
        result: "重点更集中"
      },
      {
        role: "研二 · 算法实习",
        quote: "我不太会写简历里的模型和实验部分，生成后至少知道应该按数据、方法、指标和结果去组织。",
        result: "结构更像简历"
      },
      {
        role: "社招 · 运营分析",
        quote: "排版省了不少时间。之前自己调PDF总是行距很怪，现在生成出来再复制微调，整体效率高很多。",
        result: "排版更省心"
      }
    ]
  },

  onUnload() {
    this.clearProgressTimer();
  },

  onShow() {
    this.loadQuota();
  },

  loadQuota() {
    wx.cloud.callFunction({
      name: "getQuota"
    }).then((response) => {
      const result = response.result;
      if (!result || !result.ok) return;
      this.setData({ quota: result.data });
    }).catch((error) => {
      console.warn("load quota failed", error);
    });
  },

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [field]: event.detail.value
    });
  },

  onProfileInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`profile.${field}`]: event.detail.value
    });
  },

  selectMode(event) {
    this.setData({
      mode: event.currentTarget.dataset.value
    });
  },

  selectTone(event) {
    this.setData({
      tone: event.currentTarget.dataset.value
    });
  },

  choosePdf() {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: ["pdf"],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          wx.showToast({ title: "PDF不能超过10MB", icon: "none" });
          return;
        }
        this.setData({
          pdfFile: file,
          pdfFileID: ""
        });
      }
    });
  },

  clearPdf() {
    this.setData({
      pdfFile: null,
      pdfFileID: ""
    });
  },

  validate() {
    if (!this.data.targetRole.trim()) {
      wx.showToast({ title: "请填写目标岗位", icon: "none" });
      return false;
    }

    if (this.data.mode === "paste" && this.data.resumeText.trim().length < 80) {
      wx.showToast({ title: "简历内容至少80字", icon: "none" });
      return false;
    }

    if (this.data.mode === "pdf" && !this.data.pdfFile) {
      wx.showToast({ title: "请先选择PDF简历", icon: "none" });
      return false;
    }

    if (this.data.mode === "create") {
      const profile = this.data.profile;
      const hasEnoughInfo = [profile.education, profile.work, profile.projects, profile.skills, profile.selfIntro]
        .join("")
        .trim().length >= 80;
      if (!profile.name.trim()) {
        wx.showToast({ title: "请填写姓名", icon: "none" });
        return false;
      }
      if (!hasEnoughInfo) {
        wx.showToast({ title: "经历信息至少80字", icon: "none" });
        return false;
      }
    }

    return true;
  },

  async submitResume() {
    if (!this.validate() || this.data.loading) return;

    this.startProgress();

    try {
      const payload = await this.buildPayload();
      const response = await wx.cloud.callFunction({
        name: "optimizeResume",
        data: payload
      });

      const result = response.result;
      if (!result || !result.ok) {
        if (result && result.code === "NO_ANALYSIS_QUOTA") {
          this.showQuotaModal(result);
          return;
        }
        throw new Error((result && result.message) || "优化失败");
      }

      this.finishProgress();
      this.openResult(result.data, !!result.demoMode);
      this.loadQuota();
    } catch (error) {
      console.error("submitResume failed", error);
      wx.showModal({
        title: "AI处理失败",
        content: this.getErrorMessage(error),
        showCancel: false
      });
    } finally {
      this.stopProgress();
    }
  },

  async buildPayload() {
    const payload = {
      mode: this.data.mode === "pdf" ? "pdfOptimize" : this.data.mode === "create" ? "createResume" : "textOptimize",
      targetRole: this.data.targetRole.trim(),
      years: this.data.years.trim(),
      resumeText: this.data.resumeText.trim(),
      jobDescription: this.data.jobDescription.trim(),
      tone: "concise",
      profile: this.data.profile
    };

    if (this.data.mode === "pdf") {
      payload.sourceFileID = this.data.pdfFileID || (await this.uploadPdf());
    }

    return payload;
  },

  showQuotaModal(result) {
    const latestResultId = result.latestResultId || this.getLatestLocalResultId();
    wx.showModal({
      title: "免费次数已用完",
      content: latestResultId
        ? "解锁最近一次完整简历后，可获得3次岗位匹配度专业分析。"
        : "你需要先保留一份已生成结果，才能解锁完整简历并获得额外分析次数。",
      confirmText: latestResultId ? "去解锁" : "知道了",
      showCancel: !!latestResultId,
      success: (res) => {
        if (!res.confirm || !latestResultId) return;
        wx.navigateTo({
          url: `/pages/result/result?id=${latestResultId}`
        });
      }
    });
  },

  getLatestLocalResultId() {
    const history = wx.getStorageSync("resume_history") || [];
    const latest = history.find((item) => item && (item.resultId || item.id));
    return latest ? (latest.resultId || latest.id) : "";
  },

  uploadPdf() {
    if (this.data.pdfFileID) return Promise.resolve(this.data.pdfFileID);

    this.setData({
      uploading: true,
      submitText: "正在上传PDF...",
      loadingStepText: "正在上传PDF到云存储"
    });

    const rawName = this.data.pdfFile.name || "resume.pdf";
    const name = rawName.replace(/[^\w.-]/g, "_");
    const cloudPath = `resume-uploads/${Date.now()}-${name}`;

    return wx.cloud.uploadFile({
      cloudPath,
      filePath: this.data.pdfFile.path
    }).then((res) => {
      this.setData({
        pdfFileID: res.fileID,
        uploading: false,
        submitText: "正在生成...",
        loadingStepText: "正在提取PDF文字"
      });
      return res.fileID;
    }).catch((error) => {
      this.setData({
        uploading: false,
        submitText: this.data.loading ? "正在生成..." : "开始处理"
      });
      throw new Error(error.errMsg || error.message || "PDF上传失败，请确认云存储已开通。");
    });
  },

  startProgress() {
    this.clearProgressTimer();

    let progress = 6;
    let stepIndex = 0;
    this.progressTimer = setInterval(() => {
      const nextProgress = Math.min(92, progress + Math.ceil(Math.random() * 7));
      const nextStepIndex = Math.min(
        this.data.loadingSteps.length - 1,
        Math.floor(nextProgress / 18)
      );

      progress = nextProgress;
      stepIndex = Math.max(stepIndex, nextStepIndex);
      this.setData({
        progress,
        loadingStepText: this.data.loadingSteps[stepIndex]
      });
    }, 900);

    this.setData({
      loading: true,
      submitText: "正在生成...",
      progress,
      loadingStepText: this.data.loadingSteps[0]
    });
  },

  finishProgress() {
    this.setData({
      progress: 100,
      loadingStepText: "生成完成，正在打开结果"
    });
  },

  stopProgress() {
    this.clearProgressTimer();
    this.setData({
      loading: false,
      uploading: false,
      submitText: "开始处理",
      progress: 0,
      loadingStepText: ""
    });
  },

  clearProgressTimer() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  },

  getErrorMessage(error) {
    if (!error) return "请检查云函数、DeepSeek API Key、云存储权限和网络配置。";
    return error.message || error.errMsg || "请检查云函数、DeepSeek API Key、云存储权限和网络配置。";
  },

  openResult(data, demoMode) {
    const record = {
      id: data.resultId || Date.now().toString(),
      resultId: data.resultId || "",
      createdAt: new Date().toISOString(),
      targetRole: data.targetRole || this.data.targetRole.trim(),
      score: data.score,
      isUnlocked: !!data.isUnlocked,
      demoMode: !!demoMode
    };

    app.globalData.lastResult = record;
    this.saveHistory(record);

    wx.navigateTo({
      url: `/pages/result/result?id=${record.id}`
    });
  },

  saveHistory(record) {
    const history = wx.getStorageSync("resume_history") || [];
    const nextHistory = [record]
      .concat(history.filter((item) => item.id !== record.id))
      .slice(0, 20);
    wx.setStorageSync("resume_history", nextHistory);
  },

  buildLocalDemoResult() {
    const role = this.data.targetRole.trim();
    const modeText = this.data.mode === "create" ? "从零创建" : this.data.mode === "pdf" ? "PDF上传" : "文本优化";

    return {
      score: this.data.jobDescription.trim() ? 80 : 72,
      summary: `这是${modeText}的本地演示结果。部署云函数并配置DEEPSEEK_API_KEY后，会基于真实内容生成优化简历和PDF文件。`,
      optimizedResume: [
        `求职目标：${role}`,
        "",
        "个人优势",
        `- 具备与${role}相关的项目执行、问题拆解和协作沟通经验。`,
        "- 能围绕业务目标梳理任务优先级，并推动任务按计划交付。",
        "- 重视结果复盘，可将经验沉淀为可复用流程。",
        "",
        "项目经历",
        "- 负责需求梳理、方案执行和问题跟进，提升团队协作效率。",
        "- 与相关角色沟通目标、范围和风险，减少返工。",
        "- 可补充：项目规模、关键指标、效率提升、收入增长或成本下降数据。",
        "",
        "技能能力",
        "- 岗位相关工具、技术栈或业务方法：请根据真实经历补充。",
        "- 沟通协作：能清晰同步进度、风险和解决方案。"
      ].join("\n"),
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
      pdfFileID: "",
      pdfNotice: "演示模式不会生成云端PDF。"
    };
  }
});
