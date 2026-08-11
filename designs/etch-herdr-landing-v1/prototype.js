/* Etch 官网 V2 原型 · 交互逻辑
 *
 * 所有阶段 id、阶段名、状态枚举、并发池、Provider 名、分数维度、
 * 文档风格方向与按钮文案都取自 Etch 真实源码：
 *   src/shared/task-schema.ts     STAGE_IDS / StageStatus / SUMMARY_SCORE_LABELS / IllustrationPhase …
 *   src/shared/pipeline.ts        POOL_KINDS / POOL_LABELS / POOL_BY_STAGE
 *   src/renderer/ui.tsx           stageLabels / providerNames / taskKindLabel / poolStateLabel …
 *   src/renderer/WorkbenchView.tsx 工作台骨架与按钮文案
 *   src/renderer/DocumentWorkbench.tsx 文档阶段名 / HTML_DIRECTIONS / 信息字段
 * 正文内容是标注过的示例数据，不代表任何真实任务或真实账号。
 */
(function () {
  'use strict';

  /* ---------------- 真实枚举与标签表 ---------------- */

  // src/renderer/ui.tsx stageLabels
  var STAGE_LABELS = {
    source: '抓取',
    inspect: '探测',
    english: '英文字幕',
    cues: '英文清理与审计',
    translate: '翻译',
    audit: '术语审计',
    review: '人工校对',
    srt: '生成 SRT',
    burn: '压制',
    verify: '验证',
    digest: '素材分析',
    research: '外部核验',
    summary: '长文整理',
    illustrate: '配图'
  };

  // src/renderer/DocumentWorkbench.tsx DOCUMENT_STAGES
  var DOCUMENT_STAGE_LABELS = {
    source: '抓取',
    inspect: '正文清洗',
    translate: '文档翻译',
    review: '文档校对',
    verify: '完整性验证'
  };

  // src/renderer/DocumentWorkbench.tsx STAGE_STATUS_LABELS
  var STAGE_STATUS_LABELS = {
    pending: '等待中',
    ready: '可处理',
    running: '处理中',
    checkpoint: '待确认',
    failed: '失败',
    paused: '已暂停',
    completed: '已完成',
    stale: '待重建',
    skipped: '已跳过'
  };

  // src/renderer/ui.tsx providerNames
  var PROVIDER_NAMES = {
    claude: 'Claude Code',
    codex: 'Codex',
    qoder: 'Qoder',
    opencode: 'OpenCode'
  };

  // src/shared/pipeline.ts POOL_KINDS 顺序 + POOL_BY_STAGE
  var POOL_KINDS = ['download', 'whisper', 'agent', 'audit', 'ffmpeg', 'image'];
  var POOL_BY_STAGE = {
    source: 'download',
    english: 'whisper',
    cues: 'audit',
    translate: 'agent',
    audit: 'audit',
    burn: 'ffmpeg',
    digest: 'agent',
    research: 'agent',
    summary: 'agent',
    illustrate: 'image'
  };

  // src/shared/task-schema.ts SHARED_STAGE_IDS
  var SHARED_STAGE_IDS = ['source', 'inspect', 'english', 'cues'];

  // src/shared/task-schema.ts SUMMARY_SCORE_KEYS / SUMMARY_SCORE_LABELS
  var SCORE_KEYS = ['factuality', 'completeness', 'structure', 'readability', 'conversation', 'finalComment'];
  var SCORE_LABELS = {
    factuality: '事实保真',
    completeness: '信息完整',
    structure: '叙事结构',
    readability: '中文可读性',
    conversation: '对话感',
    finalComment: '最后评论'
  };

  // src/renderer/DocumentWorkbench.tsx HTML_DIRECTIONS / HTML_DIAL_LABELS
  var HTML_DIAL_LABELS = ['衬线', '密度', '对比'];
  var HTML_DIRECTIONS = [
    { id: 'A', name: '杂志长文', templateId: 'article-magazine', description: '编辑部式层级与醒目引文', dials: [72, 55, 42] },
    { id: 'B', name: '极简阅读', templateId: 'minimal', description: '单列宽留白，适合沉浸阅读', dials: [38, 28, 18] },
    { id: 'C', name: '大胆编辑', templateId: 'editorial', description: '强标题与不对称构图', dials: [84, 63, 78] },
    { id: 'D', name: '冷静工业', templateId: 'dark-industrial', description: '暗底冷蓝，信息密度更高', dials: [12, 74, 92] }
  ];

  var REVIEW_PAGE_SIZE = 100; // src/renderer/WorkbenchView.tsx

  /* ---------------- 图标（与 App 的 Icon 组件同形） ---------------- */

  var ICONS = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="4 12 10 18 20 6"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
    warning: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20z"/><line x1="12" y1="10" x2="12" y2="14"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 15l6-6M11 6l1-1a3.5 3.5 0 0 1 5 5l-1 1M13 18l-1 1a3.5 3.5 0 0 1-5-5l1-1"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    empty: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><line x1="7" y1="10" x2="17" y2="10"/><line x1="7" y1="14" x2="14" y2="14"/></svg>'
  };

  /* ---------------- 示例任务数据（标注为示例，非真实持久化数据） ---------------- */

  var EXAMPLE_VIDEO = 'https://www.youtube.com/watch?v=EXAMPLE-ID';

  var SUBTITLE_CUES = [
    [
      { id: 101, start: '9:12', end: '9:16', en: 'Every attention head learns a different relationship.', zh: '每个注意力头都会学到一种不同的关系。' },
      { id: 102, start: '9:16', end: '9:21', en: 'So the model can look at several positions at once.', zh: '所以模型可以同时关注多个位置。' },
      { id: 103, start: '9:21', end: '9:26', en: 'We concatenate the heads and project them back down.', zh: '我们把这些头拼接起来，再投影回原来的维度。' },
      { id: 104, start: '9:26', end: '9:31', en: 'That projection is what makes the shapes line up again.', zh: '正是这一步投影让张量形状重新对齐。' },
      { id: 105, start: '9:31', end: '9:35', en: 'Nothing here is learned in isolation.', zh: '这里没有任何一部分是孤立学到的。' }
    ],
    [
      { id: 201, start: '17:04', end: '17:09', en: 'Residual connections keep the earlier signal available.', zh: '残差连接让更早的信号一直可用。' },
      { id: 202, start: '17:09', end: '17:14', en: 'Without them the gradient has a much longer path.', zh: '没有它们，梯度要走的路会长得多。' },
      { id: 203, start: '17:14', end: '17:18', en: 'Layer norm then puts everything back on a comparable scale.', zh: '层归一化再把所有值拉回可比的尺度。' },
      { id: 204, start: '17:18', end: '17:23', en: 'This is the block you stack, over and over.', zh: '这就是被反复堆叠的那个基本块。' },
      { id: 205, start: '17:23', end: '17:27', en: 'Depth is where the capacity comes from.', zh: '容量正是来自深度。' }
    ]
  ];

  var GLOSSARY = [
    { en: 'attention head', zh: '注意力头' },
    { en: 'residual connection', zh: '残差连接' },
    { en: 'layer norm', zh: '层归一化' },
    { en: 'embedding', zh: '嵌入' },
    { en: 'projection', zh: '投影' },
    { en: 'token', zh: '词元' }
  ];

  var DOC_SOURCE_MD = '# Why local-first pipelines win\n\nA pipeline that keeps its state on disk can be interrupted\nat any point without losing verified work.\n\n## Resumability is a storage property\n\nThe expensive part of a long job is rarely the CPU time.\nIt is the verified intermediate result.\n\n- Each batch is written once it passes validation.\n- A restart only re-runs what was never verified.\n- The manifest is the authority, not the process.\n\n> If a crash costs you the whole run, the run was never\n> resumable to begin with.\n\n## What this costs you\n\nYou trade a little bookkeeping for the ability to stop.';

  var DOC_TRANSLATED_MD = '# 为什么本地优先的流水线更靠得住\n\n把状态写在磁盘上的流水线，可以在任何一点被打断，\n而不丢掉已经验证过的成果。\n\n## 可续跑是一种存储属性\n\n长任务里最贵的部分很少是 CPU 时间，\n而是那些已经验证过的中间结果。\n\n- 每个批次一旦通过校验就立刻落盘。\n- 重启只会重跑从未验证过的部分。\n- 权威是 manifest，不是进程。\n\n> 如果一次崩溃就让你损失整轮运行，\n> 那这轮运行从一开始就不是可续跑的。\n\n## 代价是什么\n\n你用一点记账开销，换来了「可以随时停下」。';

  var TASKS = {
    subtitle: {
      kind: 'subtitle',
      kindLabel: '双语硬字幕',
      provider: 'claude',
      model: 'cli-default',
      title: '示例任务 · Attention 机制讲解',
      source: EXAMPLE_VIDEO,
      inputKind: 'url',
      currentMessage: '等待人工校对确认',
      switchLabel: '视频 · 10 阶段',
      switchHint: 'source → verify · 交付 bilingual.srt / final.mp4',
      mark: '译',
      stages: [
        { id: 'source', status: 'completed', sub: 'youtube' },
        { id: 'inspect', status: 'completed', sub: '1920×1080' },
        { id: 'english', status: 'completed', sub: 'manual' },
        { id: 'cues', status: 'completed', sub: '' },
        { id: 'translate', status: 'completed', sub: '5/5 批' },
        { id: 'audit', status: 'completed', sub: '' },
        { id: 'review', status: 'checkpoint', sub: 'manual-review' },
        { id: 'srt', status: 'pending', sub: '' },
        { id: 'burn', status: 'pending', sub: '' },
        { id: 'verify', status: 'pending', sub: '' }
      ],
      primaryAction: { label: '完成校对并继续', disabled: false },
      secondaryActions: [],
      checkpointBanner: 'review',
      tabs: [
        { id: 'review', label: '校对', count: 412 },
        { id: 'info', label: '任务信息' },
        { id: 'glossary', label: '审计术语', count: GLOSSARY.length },
        { id: 'style', label: '样式' }
      ],
      defaultTab: 'review',
      stateBar: '已自动保存',
      info: [
        ['Provider', 'Claude Code · cli-default', false],
        ['来源', EXAMPLE_VIDEO, false],
        ['发布时间', '2026-05-14', false],
        ['画面', '1920 × 1080', false],
        ['时长', '18:42', false],
        ['字幕来源', '人工字幕', false],
        ['翻译批次', '5 / 5 已验证', false],
        ['审计术语', GLOSSARY.length + ' 条', true],
        ['B站投稿', '未投稿', false]
      ],
      infoKind: '人工字幕',
      cueTotal: 412
    },

    summary: {
      kind: 'summary',
      kindLabel: '视频总结',
      provider: 'qoder',
      model: 'cli-default',
      title: '示例任务 · Attention 机制讲解',
      source: EXAMPLE_VIDEO,
      inputKind: 'url',
      currentMessage: '等待选择配图 agent',
      switchLabel: '视频 · 8 阶段',
      switchHint: '复用前 4 步 · 交付 summary.md / images/',
      mark: '总',
      stages: [
        { id: 'source', status: 'completed', sub: 'youtube' },
        { id: 'inspect', status: 'completed', sub: '1920×1080' },
        { id: 'english', status: 'completed', sub: 'manual' },
        { id: 'cues', status: 'completed', sub: '' },
        { id: 'digest', status: 'completed', sub: '9 段' },
        { id: 'research', status: 'completed', sub: '7 条' },
        { id: 'summary', status: 'completed', sub: 'B 为基稿' },
        { id: 'illustrate', status: 'checkpoint', sub: 'agent-pending' }
      ],
      primaryAction: { label: '等待配图确认', disabled: true },
      secondaryActions: [],
      checkpointBanner: 'illustrate',
      tabs: [
        { id: 'summary', label: '总结' },
        { id: 'info', label: '任务信息' },
        { id: 'drafts', label: '三稿记录' }
      ],
      defaultTab: 'summary',
      stateBar: '等待选择配图 agent',
      info: [
        ['Provider', 'Qoder · cli-default', false],
        ['来源', EXAMPLE_VIDEO, false],
        ['时长', '18:42', false],
        ['素材分段', '9 段已验证', true],
        ['外部核验', '已完成 · 7 条事实 / 12 次检索', true],
        ['基稿', 'B（51.0 / 60）', false],
        ['配图阶段', 'agent-pending', false],
        ['计划配图', '0 / 9 张', false]
      ],
      infoKind: '视频总结',
      drafts: [
        {
          id: 'A', title: '按时间顺序讲清多头注意力', length: 6420,
          scores: { factuality: 8.4, completeness: 7.6, structure: 7.2, readability: 8.0, conversation: 6.8, finalComment: 7.0 },
          total: 45.0
        },
        {
          id: 'B', title: '从「为什么要多个头」切入', length: 7180,
          scores: { factuality: 8.8, completeness: 8.6, structure: 8.4, readability: 8.6, conversation: 8.2, finalComment: 8.4 },
          total: 51.0
        },
        {
          id: 'C', title: '以对话复现讲者的推导过程', length: 6890,
          scores: { factuality: 7.8, completeness: 8.2, structure: 7.8, readability: 7.4, conversation: 8.8, finalComment: 7.6 },
          total: 47.6
        }
      ],
      baseDraft: 'B',
      baseReason: 'B 在事实保真与信息完整上都领先，且叙事结构最适合直接改写为终稿。',
      omissions: [
        'segment-004 提到的参数量对比未进入任何候选稿，已补回终稿。',
        'segment-007 的提问环节在 A / C 稿中被压缩，B 稿保留了原始措辞。'
      ]
    },

    document: {
      kind: 'document',
      kindLabel: '网页翻译',
      provider: 'codex',
      model: 'cli-default',
      title: 'Why local-first pipelines win',
      source: 'https://example.com/blog/local-first-pipelines',
      inputKind: 'url',
      currentMessage: '等待人工校对 Markdown 文档',
      switchLabel: '网页 · 5 阶段',
      switchHint: '不进入视频逻辑 · 交付 translation.md / translation.html',
      mark: '网',
      stages: [
        { id: 'source', status: 'completed', sub: 'web' },
        { id: 'inspect', status: 'completed', sub: '146 blocks' },
        { id: 'translate', status: 'completed', sub: '146/146 blocks' },
        { id: 'review', status: 'checkpoint', sub: '等待人工校对 Markdown 文档' },
        { id: 'verify', status: 'pending', sub: '' }
      ],
      primaryAction: { label: '等待完成校对', disabled: true },
      secondaryActions: [
        { id: 'open-source', label: '打开原网页', icon: 'link' },
        { id: 'export-markdown', label: '导出 Markdown', icon: 'folder', disabled: true }
      ],
      checkpointBanner: null,
      tabs: [
        { id: 'compare', label: '对照校对' },
        { id: 'preview', label: '中文预览' },
        { id: 'info', label: '任务信息' }
      ],
      defaultTab: 'compare',
      stateBar: '已载入 revision 10',
      info: [
        ['内容类型', '普通网页', false],
        ['来源 URL', 'https://example.com/blog/local-first-pipelines', false],
        ['站点', 'example.com', false],
        ['处理方式', '自动判断', false],
        ['来源语言', 'en', false],
        ['目标语言', 'zh-CN', false],
        ['Provider', 'Codex · cli-default', false],
        ['原文 blocks', '146', false],
        ['译文 blocks', '146', false],
        ['标题结构', '12 / 12', false],
        ['本地媒体', '9 / 9', false],
        ['完整性验证', '等待校对完成', false],
        ['校对完成', '尚未确认', false],
        ['Artifacts', '10 / 11 有效', false],
        ['Revision', '10', false]
      ],
      infoKind: '普通网页'
    }
  };

  /* ---------------- 状态 ---------------- */

  var state = {
    view: 'workbench',
    kind: 'document',
    tab: { subtitle: 'glossary', summary: 'summary', document: 'compare' },
    pipelineOpen: { subtitle: false, summary: false, document: true },
    cueId: 101,
    cuePage: 0,
    stage: null,
    direction: 'A',
    htmlGenerated: false,
    documentReviewed: false,
    videoPlaying: false,
    notice: ''
  };

  /* ---------------- 工具 ---------------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }

  function stageLabel(task, id) {
    return task.kind === 'document' ? DOCUMENT_STAGE_LABELS[id] : STAGE_LABELS[id];
  }

  function isDone(status) {
    return status === 'completed' || status === 'skipped';
  }

  function currentTask() {
    return TASKS[state.kind];
  }

  function query(selector) {
    return document.querySelector(selector);
  }

  /* ---------------- 渲染：任务头部 ---------------- */

  function renderHeader(task) {
    var activeStage = task.stages.find(function (stage) {
      return ['running', 'checkpoint', 'failed', 'paused', 'stale'].indexOf(stage.status) >= 0;
    });
    var tag = PROVIDER_NAMES[task.provider] + ' · ' + (activeStage ? stageLabel(task, activeStage.id) : task.currentMessage);

    var actions = task.secondaryActions.map(function (action) {
      return '<button class="secondary-button" type="button" data-demo-action="' + action.id + '"'
        + (action.disabled ? ' disabled' : '') + '>' + ICONS[action.icon] + esc(action.label) + '</button>';
    }).join('');
    actions += '<button class="primary-button" type="button" data-primary-action="true"' + (task.primaryAction.disabled ? ' disabled' : '') + '>'
      + esc(task.primaryAction.label) + '</button>';

    // 真实 App 只显示当前视频已有的成果；其他示例从任务队列进入。
    var outputTabs = '';
    if (task.kind !== 'document') {
      outputTabs = '<div class="output-tabs" role="group" aria-label="视频成果">'
        + '<button type="button" class="is-active" aria-pressed="true" disabled>'
        + '<span>' + esc(task.kindLabel) + '</span>'
        + '<small>' + esc(task.currentMessage) + '</small>'
        + '</button>'
        + '</div>';
    }

    return '<header class="wb-header">'
      + '<button class="back-link" type="button" data-demo-action="queue">' + ICONS.back + '任务队列</button>'
      + '<div class="wb-title-row">'
      + '<div><span class="provider-tag">' + esc(tag) + '</span>'
      + '<h3>' + esc(task.title) + '</h3>'
      + '<code class="task-source">' + ICONS.link + '<span>' + esc(task.source) + '</span></code></div>'
      + '<div class="wb-actions">' + actions + '</div>'
      + '</div>'
      + outputTabs
      + '</header>';
  }

  function renderNotice() {
    if (!state.notice) return '';
    return '<p class="prototype-notice" role="status">' + esc(state.notice) + '</p>';
  }

  /* ---------------- 渲染：checkpoint 提示 ---------------- */

  function renderCheckpointBanner(task) {
    if (task.checkpointBanner === 'review') {
      var step = state.tab.subtitle === 'glossary' ? 'glossary' : 'review';
      return '<section class="review-checkpoint-banner" role="region" aria-label="人工校对 checkpoint">'
        + '<div class="review-checkpoint-copy">'
        + '<span class="review-checkpoint-icon" aria-hidden="true">' + ICONS.pause + '</span>'
        + '<div><strong>流水线已暂停在人工校对</strong>'
        + '<span>先核对术语并把修改一次性同步到全部引用 cue，再检查具体译文。确认完成前不会生成 SRT 或压制成片。</span></div>'
        + '</div>'
        + '<div class="review-checkpoint-steps" role="group" aria-label="人工校对步骤">'
        + '<button type="button" data-step="glossary" class="' + (step === 'glossary' ? 'is-active' : '') + '"'
        + ' aria-pressed="' + (step === 'glossary') + '"><span>1</span> 核对术语</button>'
        + '<button type="button" data-step="review" class="' + (step === 'review' ? 'is-active' : '') + '"'
        + ' aria-pressed="' + (step === 'review') + '"><span>2</span> 核对译文</button>'
        + '<span class="review-checkpoint-status" role="status">当前修改均已保存</span>'
        + '</div></section>';
    }
    if (task.checkpointBanner === 'illustrate') {
      return '<aside class="permission-banner" role="status">' + ICONS.warning
        + '<div><strong>配图阶段等待选择 agent</strong>'
        + '<span>封面通过验收前不会生成其余配图。图像能力白名单只包含实测通过的 Provider，未验证的会置灰并给出原因。</span></div>'
        + '</aside>';
    }
    return '';
  }

  /* ---------------- 渲染：流水线 ---------------- */

  function railNode(task, stage, index, interactive) {
    var label = stageLabel(task, stage.id);
    // ui.tsx stageSubLabel 回落到原始 status 字符串；
    // DocumentWorkbench.tsx 回落到中文 STAGE_STATUS_LABELS。
    var fallback = task.kind === 'document'
      ? STAGE_STATUS_LABELS[stage.status]
      : (stage.status === 'pending' ? '' : stage.status);
    var sub = stage.sub || fallback;
    var dot = stage.status === 'completed' ? ICONS.check : String(index + 1).padStart(2, '0');
    var inner = '<span class="rail-dot">' + dot + '</span>'
      + '<span class="rail-label">' + esc(label) + '</span>'
      + '<span class="rail-sub">' + esc(sub) + '</span>';
    var attributes = ' data-status="' + stage.status + '"'
      + (isDone(stage.status) ? ' data-done="true"' : '');

    if (!interactive) {
      return '<div class="rail-node"' + attributes + ' role="listitem">' + inner + '</div>';
    }
    var pressed = state.stage === stage.id;
    return '<button type="button" class="rail-node"' + attributes
      + ' data-stage="' + stage.id + '" aria-pressed="' + pressed + '"'
      + ' aria-label="' + esc(label + ' 阶段，' + STAGE_STATUS_LABELS[stage.status]) + '">'
      + inner + '</button>';
  }

  function renderRail(task, stages, offset, interactive, label) {
    return '<div class="rail-scroll"><div class="rail" style="--rail-columns:' + stages.length + '"'
      + (interactive ? '' : ' role="list"') + ' aria-label="' + esc(label) + '">'
      + stages.map(function (stage, index) {
        return railNode(task, stage, index + offset, interactive);
      }).join('')
      + '</div></div>';
  }

  function renderStageDetail(task) {
    if (!state.stage) return '';
    var stage = task.stages.find(function (item) { return item.id === state.stage; });
    if (!stage) return '';
    var pool = POOL_BY_STAGE[stage.id];
    return '<dl class="stage-detail" role="status">'
      + '<dt>阶段 id</dt><dd>' + esc(stage.id) + '</dd>'
      + '<dt>阶段名</dt><dd>' + esc(stageLabel(task, stage.id)) + '</dd>'
      + '<dt>status</dt><dd>' + esc(stage.status) + ' · ' + esc(STAGE_STATUS_LABELS[stage.status]) + '</dd>'
      + '<dt>并发池</dt><dd>' + esc(pool ? pool : '不占用并发池') + '</dd>'
      + (stage.sub ? '<dt>阶段摘要</dt><dd>' + esc(stage.sub) + '</dd>' : '')
      + '</dl>';
  }

  function renderPools(task) {
    var used = POOL_KINDS.filter(function (pool) {
      return task.stages.some(function (stage) { return POOL_BY_STAGE[stage.id] === pool; });
    });
    return '<div class="pipeline-pools">' + used.map(function (pool) {
      var statuses = task.stages
        .filter(function (stage) { return POOL_BY_STAGE[stage.id] === pool; })
        .map(function (stage) { return stage.status; });
      // src/renderer/ui.tsx poolState 的优先级顺序
      var status = statuses.indexOf('failed') >= 0 ? 'failed'
        : statuses.indexOf('running') >= 0 ? 'running'
          : statuses.indexOf('checkpoint') >= 0 ? 'checkpoint'
            : statuses.every(isDone) ? 'completed' : 'pending';
      // src/renderer/ui.tsx poolStateLabel
      var text = status === 'completed' ? '已释放'
        : status === 'running' ? '运行中'
          : status === 'failed' ? '失败'
            : status === 'checkpoint' ? '待确认' : '空闲';
      return '<span class="pool-tag"><span class="dot" data-status="' + status + '"></span>'
        + '<b>' + pool + '</b>' + text + '</span>';
    }).join('') + '</div>';
  }

  function renderPipeline(task) {
    var done = task.stages.filter(function (stage) { return isDone(stage.status); }).length;
    var percent = Math.round((done / task.stages.length) * 100);
    var checkpointCount = task.stages.filter(function (stage) { return stage.status === 'checkpoint'; }).length;

    var body;
    if (task.kind === 'document') {
      body = renderRail(task, task.stages, 0, true, '网页翻译阶段');
    } else {
      var shared = task.stages.filter(function (stage) { return SHARED_STAGE_IDS.indexOf(stage.id) >= 0; });
      var own = task.stages.filter(function (stage) { return SHARED_STAGE_IDS.indexOf(stage.id) < 0; });
      var companionKind = task.kind === 'subtitle' ? 'summary' : 'subtitle';
      var companionLabel = companionKind === 'summary' ? '视频总结' : '双语硬字幕';
      var companionSteps = companionKind === 'summary' ? 4 : 6;
      var activeStage = own.find(function (stage) { return !isDone(stage.status); }) || own[own.length - 1];
      var activeStageIndex = task.stages.findIndex(function (stage) { return stage.id === activeStage.id; }) + 1;

      body = '<section class="pipeline-map" aria-label="共享底稿与成果分支">'
        + '<section class="pipeline-shared-card" aria-label="共享底稿">'
        + '<div class="pipeline-group-head"><span><strong>共享底稿</strong><small>两个成果只执行一次</small></span>'
        + '<em>' + shared.filter(function (stage) { return isDone(stage.status); }).length + ' / ' + shared.length + ' 已就绪</em></div>'
        + renderRail(task, shared, 0, true, '共享底稿阶段') + '</section>'
        + '<div class="pipeline-handoff" aria-hidden="true"><span>形成成果</span></div>'
        + '<div class="pipeline-outcome-stack">'
        + '<section class="outcome-lane" data-active="true" aria-label="当前成果：' + esc(task.kindLabel) + '">'
        + '<div class="outcome-lane-head"><span class="outcome-mark" data-kind="' + task.kind + '">' + esc(task.mark) + '</span>'
        + '<span class="outcome-lane-copy"><strong>' + esc(task.kindLabel) + '</strong>'
        + '<small><i></i>第 ' + String(activeStageIndex).padStart(2, '0') + ' 步 · ' + esc(task.currentMessage) + '</small></span>'
        + '<em>当前</em></div>'
        + renderRail(task, own, SHARED_STAGE_IDS.length, true, task.kindLabel + '阶段') + '</section>'
        + '<button class="companion-lane" type="button" data-output="' + companionKind + '"'
        + ' aria-label="追加' + companionLabel + '，复用共享底稿">'
        + '<span class="companion-plus">' + ICONS.plus + '</span>'
        + '<span><strong>追加' + companionLabel + '</strong><small>复用已完成的 4 步，只新增 ' + companionSteps + ' 步</small></span>'
        + '<em>复用 4 步</em></button>'
        + '</div></section>';
    }

    var miniMessage = task.kind === 'document'
      ? done + ' / ' + task.stages.length + ' · ' + task.currentMessage
      : SHARED_STAGE_IDS.filter(function (id) {
        var stage = task.stages.find(function (item) { return item.id === id; });
        return stage && isDone(stage.status);
      }).length + ' / ' + SHARED_STAGE_IDS.length + ' 共享 · 1 / 2 个成果';
    var focusedStatus = task.kind === 'subtitle' && checkpointCount
      ? '<span class="pc-focus">' + ICONS.pause + '人工校对待确认</span>'
      : task.kind === 'summary' && checkpointCount
        ? '<span class="pc-focus is-warn">' + ICONS.warning + esc(task.currentMessage) + '</span>'
        : '';
    var mini = '<span class="pc-msg">' + esc(miniMessage) + '</span>'
      + '<span class="mini-bar" role="progressbar" aria-label="流水线总体进度" aria-valuemin="0" aria-valuemax="100"'
      + ' aria-valuenow="' + percent + '"><i style="width:' + percent + '%"></i></span>'
      + focusedStatus
      + (task.kind === 'document' && checkpointCount ? '<span class="warn">' + ICONS.warning + checkpointCount + ' 处待确认</span>' : '');

    return '<details class="pipeline-collapse"' + (state.pipelineOpen[task.kind] ? ' open' : '') + '>'
      + '<summary><span class="pipeline-chevron">' + ICONS.chevron + '</span>'
      + '<span class="pc-title">处理流水线</span>'
      + '<span class="pc-mini">' + mini + '</span></summary>'
      + '<div class="pc-body">' + body + renderStageDetail(task)
      + (task.kind === 'document' ? '' : renderPools(task)) + '</div>'
      + '</details>';
  }

  /* ---------------- 渲染：工作区面板 ---------------- */

  function renderCuePanel(task) {
    var cues = SUBTITLE_CUES[state.cuePage];
    var from = state.cuePage * REVIEW_PAGE_SIZE + 1;
    var to = Math.min(from + REVIEW_PAGE_SIZE - 1, task.cueTotal);

    var rows = cues.map(function (cue) {
      var current = state.cueId === cue.id;
      return '<button type="button" class="cue-row' + (current ? ' is-current' : '') + '"'
        + ' data-cue="' + cue.id + '"' + (current ? ' aria-current="true"' : '')
        + ' aria-label="' + esc('Cue ' + cue.id + '，' + cue.start + ' 至 ' + cue.end) + '">'
        + '<span class="cue-col cue-en-col">'
        + '<span class="cue-meta"><span class="stamp"><b>#' + cue.id + '</b>'
        + esc(cue.start) + ' – ' + esc(cue.end) + '</span>'
        + '<span class="cue-play">' + ICONS.play + '</span></span>'
        + '<span class="cue-en">' + esc(cue.en) + '</span></span>'
        + '<span class="cue-col cue-zh-col">'
        + '<span class="cue-zh">' + esc(cue.zh) + '</span>'
        + '<span class="edit-hint">Cue ' + cue.id + '</span></span>'
        + '</button>';
    }).join('');

    return '<div class="tp-colhead"><span>英文原文 · 0:00–18:42</span><span>中文译文 · 简体中文</span></div>'
      + '<div class="panel-scroll">' + rows + '</div>'
      + '<footer class="pagination"><span class="mono">' + from + '–' + to + ' / ' + task.cueTotal + '</span>'
      + '<div><button class="secondary-button" type="button" data-page="prev"'
      + (state.cuePage === 0 ? ' disabled' : '') + '>上一页</button>'
      + '<button class="secondary-button" type="button" data-page="next"'
      + (state.cuePage >= SUBTITLE_CUES.length - 1 ? ' disabled' : '') + '>下一页</button></div></footer>';
  }

  function renderInfoPanel(task) {
    return '<div class="info-body"><div class="task-info-heading">'
      + '<span class="kind">' + esc(task.infoKind) + '</span>'
      + '<p>' + esc(task.currentMessage) + '</p></div>'
      + '<dl class="inspector-grid">' + task.info.map(function (row) {
        return '<div><dt>' + esc(row[0]) + '</dt><dd' + (row[2] ? ' class="ok"' : '') + '>'
          + esc(row[1]) + '</dd></div>';
      }).join('') + '</dl></div>';
  }

  function renderGlossaryPanel() {
    return '<div class="info-body"><div class="task-info-heading">'
      + '<span class="kind">' + GLOSSARY.length + ' 条术语</span>'
      + '<p>统一写法修改先保存在本机草稿；预览影响后一次性应用到全部引用 cue，并同步历史术语表。</p></div>'
      + '<dl class="inspector-grid">' + GLOSSARY.map(function (item) {
        return '<div><dt>' + esc(item.en) + '</dt><dd>' + esc(item.zh) + '</dd></div>';
      }).join('') + '</dl></div>';
  }

  function renderStylePanel() {
    return '<div class="info-body"><div class="task-info-heading">'
      + '<span class="kind">硬字幕预览</span>'
      + '<p>只修改当前任务；会立即影响左侧预览，并使成片等待重新压制。</p></div>'
      + '<dl class="inspector-grid">'
      + '<div><dt>compact</dt><dd>紧凑</dd></div>'
      + '<div><dt>standard</dt><dd>标准 · 当前</dd></div>'
      + '<div><dt>large</dt><dd>大字</dd></div>'
      + '</dl></div>';
  }

  function renderSummaryPanel(task) {
    var base = task.drafts.find(function (draft) { return draft.id === task.baseDraft; });
    return '<div class="panel-scroll"><div class="summary-body">'
      + '<h4>为什么要用多个注意力头</h4>'
      + '<p>示例终稿正文。终稿以 ' + esc(task.baseDraft) + ' 稿为基础改写：'
      + esc(base.title) + '。</p>'
      + '<h5>一个头看不完一句话</h5>'
      + '<p>示例段落。素材分析把字幕切成 9 段并逐段落盘，任何后续阶段失败都不需要重跑已验证的分段。</p>'
      + '<figure class="summary-image-placeholder"><span>多头注意力的并行结构</span>'
      + '<small>images/03-attention-heads.png</small></figure>'
      + '<h5>拼接之后为什么还要投影</h5>'
      + '<p>示例段落。外部核验记录了 7 条可外查事实与 12 次检索，核验结论随任务一起保存。</p>'
      + '<h5>最后</h5>'
      + '<p>示例的「最后」评论区段落。终稿必须保留这一段，以及 8–12 处配图占位。</p>'
      + '</div></div>';
  }

  function renderDraftsPanel(task) {
    var cards = task.drafts.map(function (draft) {
      var isBase = draft.id === task.baseDraft;
      var scores = SCORE_KEYS.map(function (key) {
        var value = draft.scores[key];
        return '<div class="score-row"><span>' + esc(SCORE_LABELS[key]) + '</span>'
          + '<i><b style="width:' + (value * 10) + '%"></b></i>'
          + '<code>' + value.toFixed(1) + '</code></div>';
      }).join('');
      return '<article class="draft-card" data-base="' + isBase + '">'
        + '<div class="draft-head"><span class="draft-id">' + draft.id + '</span>'
        + '<strong>' + esc(draft.title) + '</strong>'
        + (isBase ? '<em>基稿</em>' : '')
        + '<span class="total">' + draft.total.toFixed(1) + ' / 60 · ' + draft.length + ' 字</span></div>'
        + '<div class="score-grid">' + scores + '</div></article>';
    }).join('');

    return '<div class="panel-scroll"><div class="drafts-body">' + cards
      + '<div class="draft-card"><div class="draft-head"><span class="draft-id">!</span>'
      + '<strong>遗漏清单</strong></div>'
      + '<div class="omissions"><strong>选择 ' + esc(task.baseDraft) + ' 稿的理由</strong>'
      + '<ul><li>' + esc(task.baseReason) + '</li></ul>'
      + '<strong style="margin-top:10px">补回终稿的遗漏</strong><ul>'
      + task.omissions.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('')
      + '</ul></div></div>'
      + '</div></div>';
  }

  function renderComparePanel() {
    return '<div class="tp-colhead"><span>原文 · en</span><span>译文 · zh-CN</span></div>'
      + '<div class="doc-columns">'
      + '<div class="doc-pane" tabindex="0" role="group" aria-label="原文 Markdown">' + esc(DOC_SOURCE_MD) + '</div>'
      + '<div class="doc-pane" tabindex="0" role="group" aria-label="中文译文 Markdown">' + esc(DOC_TRANSLATED_MD) + '</div>'
      + '</div>';
  }

  function renderPreviewPanel() {
    return '<div class="panel-scroll"><div class="summary-body">'
      + '<h4>为什么本地优先的流水线更靠得住</h4>'
      + '<p>把状态写在磁盘上的流水线，可以在任何一点被打断，而不丢掉已经验证过的成果。</p>'
      + '<h5>可续跑是一种存储属性</h5>'
      + '<p>长任务里最贵的部分很少是 CPU 时间，而是那些已经验证过的中间结果。每个批次一旦通过校验就立刻落盘，重启只会重跑从未验证过的部分。</p>'
      + '<h5>代价是什么</h5>'
      + '<p>你用一点记账开销，换来了「可以随时停下」。</p>'
      + '</div></div>';
  }

  function renderWorkspace(task) {
    var tab = state.tab[task.kind];
    var tabs = '<div class="tp-tabs" role="tablist" aria-label="工作台面板">'
      + task.tabs.map(function (item) {
        var active = item.id === tab;
        return '<button type="button" role="tab" class="tp-tab' + (active ? ' is-active' : '') + '"'
          + ' data-tab="' + item.id + '" aria-selected="' + active + '" tabindex="' + (active ? '0' : '-1') + '">'
          + esc(item.label)
          + (item.count !== undefined ? '<span class="n">' + item.count + '</span>' : '')
          + '</button>';
      }).join('') + '</div>';

    var statebar = '<div class="transcript-statebar">'
      + '<span role="status">' + esc(task.stateBar) + '</span>'
      + '<span class="mono">' + esc(task.kindLabel) + '</span></div>';

    var panel = '';
    if (tab === 'review') panel = renderCuePanel(task);
    else if (tab === 'info') panel = renderInfoPanel(task);
    else if (tab === 'glossary') panel = renderGlossaryPanel();
    else if (tab === 'style') panel = renderStylePanel();
    else if (tab === 'summary') panel = renderSummaryPanel(task);
    else if (tab === 'drafts') panel = renderDraftsPanel(task);
    else if (tab === 'compare') panel = renderComparePanel();
    else if (tab === 'preview') panel = renderPreviewPanel();

    return '<div class="transcript-panel" role="tabpanel" aria-label="' + esc(task.kindLabel) + '工作区">'
      + tabs + statebar + panel + '</div>';
  }

  function renderVideoPane() {
    var playing = state.videoPlaying;
    return '<section class="video-preview-panel" aria-label="视频预览">'
      + '<div class="video-well">'
      + '<div class="video-synthetic-frame" aria-hidden="true">'
      + '<span>ETCH PREVIEW · 1920 × 1080</span>'
      + '<strong>ATTENTION<br />IS A ROUTING SYSTEM</strong>'
      + '<i></i><i></i><i></i>'
      + '</div>'
      + '<div class="subtitle-overlay"><span>Every attention head learns a different relationship.</span>'
      + '<b>每个注意力头都会学到一种不同的关系。</b></div>'
      + '</div>'
      + '<div class="video-controls">'
      + '<button type="button" aria-label="后退 5 秒" data-video-action="back">−5</button>'
      + '<button type="button" class="video-play" aria-label="' + (playing ? '暂停视频' : '播放视频') + '" data-video-action="toggle">'
      + (playing ? ICONS.pause : ICONS.play) + '</button>'
      + '<button type="button" aria-label="前进 5 秒" data-video-action="forward">+5</button>'
      + '<code>' + (playing ? '9:12' : '0:00') + ' / 18:42</code>'
      + '<span class="video-scrub"><i style="width:' + (playing ? '49%' : '0%') + '"></i></span>'
      + '<button type="button" data-video-action="speed">1×</button>'
      + '<button type="button" class="video-mode" data-video-action="mode">字幕预览</button>'
      + '</div>'
      + '</section>';
  }

  function renderMediaWorkspace(task) {
    return '<div class="media-workspace">' + renderVideoPane() + renderWorkspace(task) + '</div>';
  }

  function renderDocumentWarning() {
    return '<aside class="document-warning" role="note">' + ICONS.warning
      + '<div><strong>X 内容警告</strong><span>X 首版只处理当前 status；线程、引用帖与投票不会自动展开</span></div>'
      + '</aside>';
  }

  function renderDocumentReviewBar() {
    if (state.documentReviewed) {
      return '<div class="document-review-bar is-complete" role="status">'
        + '<span class="review-checkpoint-icon">' + ICONS.check + '</span>'
        + '<div><strong>校对已完成</strong><small>完整性验证通过，可以生成 HTML 方向预览。</small></div>'
        + '</div>';
    }
    return '<div class="document-review-bar" role="status">'
      + '<span class="review-checkpoint-icon">' + ICONS.warning + '</span>'
      + '<div><strong>校对 checkpoint</strong><small>检查已通过，可以完成校对。</small></div>'
      + '<button class="primary-button document-review-complete" type="button">' + ICONS.check + '完成校对</button>'
      + '</div>';
  }

  function queueCard(task, eyebrow, detail, meta) {
    return '<button class="demo-task-card" type="button" data-open-kind="' + task.kind + '">'
      + '<span class="task-cover task-cover-' + task.kind + '"><small>' + esc(eyebrow) + '</small>'
      + '<strong>' + (task.kind === 'document' ? 'WEB →<br />MARKDOWN' : task.kind === 'summary' ? 'A · B · C<br />SUMMARY' : 'BILINGUAL<br />SUBTITLES') + '</strong>'
      + '<em>' + (task.kind === 'document' ? 'HTML' : '18:42') + '</em></span>'
      + '<span class="demo-task-copy"><span class="task-card-overline">' + esc(PROVIDER_NAMES[task.provider]) + ' · ' + esc(task.kindLabel) + ' · URL</span>'
      + '<b>' + esc(task.title) + '</b><span>' + esc(task.currentMessage) + '</span>'
      + '<code>' + esc(task.source) + '</code><small>' + esc(meta) + '</small></span>'
      + '<span class="task-card-progress"><span><b style="width:' + (task.kind === 'document' ? '60%' : task.kind === 'summary' ? '87.5%' : '60%') + '"></b></span>'
      + '<em>' + (task.kind === 'document' ? '3 / 5' : task.kind === 'summary' ? '7 / 8' : '6 / 10') + ' 阶段</em></span>'
      + '</button>';
  }

  function renderQueue() {
    return '<div class="queue-view">'
      + '<header class="queue-header"><div><span>本地双语字幕流水线</span><h3>任务队列</h3></div>'
      + '<button class="primary-button" type="button" data-demo-action="new-task">＋ 新建任务</button></header>'
      + renderNotice()
      + '<div class="queue-toolbar"><span class="is-active">全部任务 <b>3</b></span><span>未分类 <b>3</b></span>'
      + '<em>每阶段并发 3 · 队列空闲</em></div>'
      + '<div class="demo-task-grid">'
      + queueCard(TASKS.summary, '视频总结 · 等待配图', '7 / 8', '更新于刚刚 · 7 / 8 阶段')
      + queueCard(TASKS.subtitle, '双语字幕 · 人工校对', '6 / 10', '更新于刚刚 · 6 / 10 阶段')
      + queueCard(TASKS.document, '网页翻译 · 文档校对', '3 / 5', '更新于刚刚 · 3 / 5 阶段')
      + '</div></div>';
  }

  function renderShellGlossary() {
    return '<div class="queue-view glossary-view"><header class="queue-header"><div><span>跨任务统一写法</span><h3>统一术语表</h3></div>'
      + '<button class="secondary-button" type="button" data-demo-action="glossary-export">导出术语表</button></header>'
      + renderNotice()
      + '<div class="glossary-panel"><div class="glossary-panel-head"><strong>' + GLOSSARY.length + ' 条术语</strong>'
      + '<span>修改只影响示例原型，不会写入本机。</span></div>'
      + '<div class="glossary-table"><span>原文术语</span><span>统一写法</span>'
      + GLOSSARY.map(function (item) { return '<b>' + esc(item.en) + '</b><em>' + esc(item.zh) + '</em>'; }).join('')
      + '</div></div></div>';
  }

  /* ---------------- 渲染：发布为网页（文档任务的二级路径） ---------------- */

  function renderHtmlPublication() {
    if (!state.documentReviewed) {
      return '<section class="html-publication is-gated" aria-label="发布为网页">'
        + '<header class="html-heading"><div><span class="provider-tag">独立工作流 · Single-file HTML</span>'
        + '<h4>发布为网页</h4><p>基于已验证 Markdown 生成，不改变翻译流水线与 Markdown 成品。</p></div>'
        + '<span class="html-status" data-status="pending">尚未开始</span></header>'
        + '<div class="html-gated-copy"><div><strong>先生成四个真实风格方向，再选择最终方案。</strong>'
        + '<span>文档通过完整性验证后即可开始。</span></div>'
        + '<button class="primary-button" type="button" disabled>生成四方向预览</button></div></section>';
    }
    var selected = HTML_DIRECTIONS.filter(function (item) { return item.id === state.direction; })[0];
    var directions = HTML_DIRECTIONS.map(function (item) {
      var isSelected = item.id === state.direction;
      var dials = item.dials.map(function (value, index) {
        return '<span><small>' + HTML_DIAL_LABELS[index] + '</small>'
          + '<i><b style="width:' + value + '%"></b></i><code>' + value + '</code></span>';
      }).join('');
      return '<button type="button" class="html-direction" role="radio"'
        + ' data-direction="' + item.id + '" data-selected="' + isSelected + '"'
        + ' aria-checked="' + isSelected + '" tabindex="' + (isSelected ? '0' : '-1') + '">'
        + '<span class="html-direction-letter">' + item.id + '</span>'
        + '<span><strong>' + esc(item.name) + '</strong><small>' + esc(item.description) + '</small>'
        + '<span class="html-dials">' + dials + '</span></span>'
        + '</button>';
    }).join('');

    var completion = state.htmlGenerated
      ? '<div class="html-complete" role="status"><span class="review-checkpoint-icon">' + ICONS.check + '</span>'
        + '<div><strong>translation.html 已生成</strong><span>' + esc(selected.id + ' · ' + selected.templateId)
        + ' · 静态预检通过 · 桌面与移动端验收通过</span></div></div>'
      : '';

    return '<section class="html-publication" aria-label="发布为网页">'
      + '<header class="html-heading">'
      + '<div><span class="provider-tag">独立工作流 · Single-file HTML</span>'
      + '<h4>发布为网页</h4>'
      + '<p>基于已验证 Markdown 生成，不改变翻译流水线与 Markdown 成品。</p></div>'
      + '<span class="html-status" data-status="' + (state.htmlGenerated ? 'completed' : 'checkpoint') + '">'
      + (state.htmlGenerated ? '已通过验收' : '等待选择风格') + '</span></header>'
      + '<div class="html-selection">'
      + '<div class="html-selection-head">'
      + '<div><strong>选择一个方向</strong>'
      + '<span>三个维度随方向一起锁定，生成后会执行浏览器验收。</span></div>'
      + '<code data-template>' + esc(selected.templateId) + '</code></div>'
      + '<div class="html-directions" role="radiogroup" aria-label="HTML 风格方向">' + directions + '</div>'
      + completion
      + '<button class="primary-button html-generate" type="button"' + (state.htmlGenerated ? ' disabled' : '') + '>'
      + (state.htmlGenerated ? state.direction + ' · 已生成并验收' : '选择 ' + state.direction + ' · 生成 HTML') + '</button>'
      + '</div></section>';
  }

  /* ---------------- 主渲染 ---------------- */

  function render() {
    var task = currentTask();
    var main = query('#proto-app');
    var queueActive = state.view === 'queue' || state.view === 'workbench';

    document.querySelectorAll('.etch-nav-item').forEach(function (button) {
      var active = button.dataset.shellView === 'queue' ? queueActive : state.view === button.dataset.shellView;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    main.dataset.view = state.view;
    if (state.view === 'queue') {
      main.innerHTML = renderQueue();
    } else if (state.view === 'glossary') {
      main.innerHTML = renderShellGlossary();
    } else if (task.kind === 'document') {
      main.innerHTML = '<div class="app-body document-app-body">'
        + renderHeader(task)
        + renderNotice()
        + renderPipeline(task)
        + renderHtmlPublication()
        + renderDocumentWarning()
        + renderWorkspace(task)
        + renderDocumentReviewBar()
        + '</div>';
    } else {
      main.innerHTML = '<div class="app-body video-app-body">'
        + renderHeader(task)
        + renderNotice()
        + renderCheckpointBanner(task)
        + renderPipeline(task)
        + renderMediaWorkspace(task)
        + '</div>';
    }

    query('#proto-title').textContent = 'Etch';
  }

  function setKind(kind) {
    if (!TASKS[kind]) return;
    state.view = 'workbench';
    state.kind = kind;
    state.stage = null;
    state.cuePage = 0;
    state.cueId = SUBTITLE_CUES[0][0].id;
    state.notice = '';
    render();
  }

  /* ---------------- 事件 ---------------- */

  function roving(list, currentIndex, key) {
    if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % list.length;
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + list.length) % list.length;
    if (key === 'Home') return 0;
    if (key === 'End') return list.length - 1;
    return -1;
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;

    var shellView = target.closest('[data-shell-view]');
    if (shellView) {
      state.view = shellView.dataset.shellView;
      state.notice = '';
      render();
      return;
    }

    var pipelineToggle = target.closest('.pipeline-collapse > summary');
    if (pipelineToggle) {
      state.pipelineOpen[state.kind] = !pipelineToggle.parentElement.open;
      return;
    }

    var taskCard = target.closest('[data-open-kind]');
    if (taskCard) {
      setKind(taskCard.dataset.openKind);
      return;
    }

    var demoAction = target.closest('[data-demo-action]');
    if (demoAction) {
      var action = demoAction.dataset.demoAction;
      if (action === 'queue') {
        state.view = 'queue';
        state.notice = '';
        render();
        return;
      }
      state.notice = action === 'open-source'
          ? '原型演示：正式 App 会在默认浏览器打开原网页。'
          : action === 'export-markdown'
            ? '原型演示：正式 App 会导出已验证的 translation.md。'
            : action === 'new-task'
              ? '原型演示：正式 App 会打开“新建任务”窗口，并选择字幕、总结或网页翻译。'
              : '原型演示：正式 App 会导出本机统一术语表。';
      render();
      return;
    }

    var documentReview = target.closest('.document-review-complete');
    if (documentReview && !state.documentReviewed) {
      state.documentReviewed = true;
      TASKS.document.stages.forEach(function (stage) {
        if (stage.id === 'review' || stage.id === 'verify') stage.status = 'completed';
      });
      TASKS.document.stages[3].sub = '已确认';
      TASKS.document.stages[4].sub = '通过';
      TASKS.document.currentMessage = '完整性验证通过';
      TASKS.document.primaryAction = { label: '处理已完成', disabled: true };
      TASKS.document.secondaryActions[1].disabled = false;
      TASKS.document.stateBar = '已载入 revision 11';
      state.notice = '原型演示：文档校对已确认，完整性验证通过，现在可以生成 HTML 方向预览。';
      render();
      return;
    }

    var videoAction = target.closest('[data-video-action]');
    if (videoAction) {
      if (videoAction.dataset.videoAction === 'toggle') state.videoPlaying = !state.videoPlaying;
      else state.notice = '原型演示：视频控制与当前 cue 已同步。';
      render();
      return;
    }

    var primaryAction = target.closest('[data-primary-action]');
    if (primaryAction && !primaryAction.disabled && state.kind === 'subtitle') {
      TASKS.subtitle.stages.forEach(function (stage) { stage.status = 'completed'; });
      TASKS.subtitle.currentMessage = '验证完成';
      TASKS.subtitle.primaryAction = { label: '处理已完成', disabled: true };
      TASKS.subtitle.checkpointBanner = null;
      TASKS.subtitle.stateBar = '已自动保存 · 成品已验证';
      state.notice = '原型演示：已生成 bilingual.srt，并完成压制与成片验证。';
      render();
      return;
    }

    var output = target.closest('[data-output]');
    if (output && !output.disabled) {
      setKind(output.dataset.output);
      query('#prototype').scrollIntoView({ block: 'start' });
      return;
    }

    var step = target.closest('[data-step]');
    if (step) {
      state.tab.subtitle = step.dataset.step;
      render();
      return;
    }

    var tab = target.closest('.tp-tab');
    if (tab) {
      state.tab[state.kind] = tab.dataset.tab;
      render();
      return;
    }

    var stageNode = target.closest('[data-stage]');
    if (stageNode) {
      state.pipelineOpen[state.kind] = true;
      state.stage = state.stage === stageNode.dataset.stage ? null : stageNode.dataset.stage;
      render();
      return;
    }

    var cue = target.closest('[data-cue]');
    if (cue) {
      state.cueId = Number(cue.dataset.cue);
      render();
      return;
    }

    var page = target.closest('[data-page]');
    if (page && !page.disabled) {
      state.cuePage += page.dataset.page === 'next' ? 1 : -1;
      state.cueId = SUBTITLE_CUES[state.cuePage][0].id;
      render();
      return;
    }

    var direction = target.closest('[data-direction]');
    if (direction) {
      state.direction = direction.dataset.direction;
      state.htmlGenerated = false;
      render();
      var focus = query('[data-direction="' + state.direction + '"]');
      if (focus) focus.focus();
      return;
    }

    var generate = target.closest('.html-generate');
    if (generate && !generate.disabled) {
      state.htmlGenerated = true;
      render();
    }
  });

  document.addEventListener('keydown', function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (keys.indexOf(event.key) < 0) return;

    if (target.classList.contains('tp-tab')) {
      var tabs = currentTask().tabs.map(function (item) { return item.id; });
      var nextTab = roving(tabs, tabs.indexOf(state.tab[state.kind]), event.key);
      if (nextTab < 0) return;
      event.preventDefault();
      state.tab[state.kind] = tabs[nextTab];
      render();
      query('.tp-tab[data-tab="' + tabs[nextTab] + '"]').focus();
      return;
    }

    if (target.classList.contains('html-direction')) {
      var ids = HTML_DIRECTIONS.map(function (item) { return item.id; });
      var nextDirection = roving(ids, ids.indexOf(state.direction), event.key);
      if (nextDirection < 0) return;
      event.preventDefault();
      state.direction = ids[nextDirection];
      state.htmlGenerated = false;
      render();
      query('[data-direction="' + state.direction + '"]').focus();
    }
  });

  render();
})();
