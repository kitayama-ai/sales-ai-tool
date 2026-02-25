// ==========================================
// 🚀 Zoom × Notta × AI 営業商談自動採点システム v2.0
// ==========================================
//
// 📋 セットアップ手順:
// 1. このコードをGASエディタに貼り付け
// 2. スクリプトプロパティに以下を設定:
//    - GEMINI_API_KEY: Gemini APIキー
//    - NOTTA_API_KEY: Notta APIキー（契約後に設定）
// 3. TARGETS配列に営業メンバーを設定
// 4. initialSetup() を1回実行（トリガー自動設定）
// 5. testWithSampleData() でSlack/Sheets動作確認
//
// 📌 動作モード:
//   - Google Drive監視モード: monitorAllFolders()（現在）
//   - Notta APIモード: monitorNotta()（Notta契約後に切替）
//
// ==========================================

// ==========================================
// 0. 基本設定
// ==========================================
const SLACK_WEBHOOK_URL = "YOUR_SLACK_WEBHOOK_URL"; // スクリプトプロパティ or ここに直接入力
const SPREADSHEET_ID = "YOUR_SPREADSHEET_ID"; // スプレッドシートのID
const GEMINI_MODEL = "gemini-2.5-flash";

// 🎯 監視対象リスト（営業メンバー追加はここ）
const TARGETS = [
  { name: "高橋", folderId: "1W1_F6HVp2zDzjYnhQMcRK5NX5VmYDo7S", slackId: "U09ATSCD1TM" },
  { name: "坪谷", folderId: "1QYxNDh8j7IBActOwRpKbHXBd6dCBA80c", slackId: "U082RDWJ7P1" }
];

// 🔍 フィルタリング設定（Notta/Zoom対応キーワード追加済み）
const TITLE_KEYWORDS = ["RM", "ロードマップ", "会議", "メモ", "Gemini", "議事録", "Notta", "商談", "面談", "Zoom"];
const CONTENT_KEYWORDS = ["RM", "ロードマップ", "Roadmap", "会議", "文字起こし", "商談", "広告", "Meta", "Notta"];

// ⏳ 監視設定
const CHECK_MINUTES = 15;
const MAX_CHAR_LIMIT = 40000;

// ==========================================
// 1. AIへの指示書（Meta広告流入商談対応版）
// ==========================================
const AI_INSTRUCTION = `
あなたは行動経済学に基づき、成約率を最大化させる「AIセールス監査官」です。
以下の基準で商談ログを分析し、JSON形式で出力してください。

# 前提
この商談はMeta広告（Facebook/Instagram広告）からの流入リードとの商談です。
リードの温度感（広告で興味を持った段階）を考慮して採点してください。

# ⚠️採点基準の再定義
* **80点以上**: 優秀。台本通り＋顧客の感情を動かせている。
* **75点前後**: 合格ライン。全てのステップで台本（15点）を遂行できている。
* **65点〜74点**: 惜しいライン。台本の遂行を邪魔している特定の弱点（権威性など）を克服すれば化ける。
* **64点以下**: 危険水域。トークの型が崩れているため、まずはロープレで型を固めるべき。
* **台本通りなら「15点」**（基準点）
* **相手の感情が大きく動いた証拠があれば「20点」**
* **なごやかなだけの商談は厳しく減点**

# 判定ルール
* **成約**: 契約意思あり、手続きへ。
* **トスアップ成功**: 次回（ロードマップ作成会等）への参加確定。※成約と同等の成功とする。
* **保留**: 検討、持ち帰り。
* **失注**: 明確な断り。

# 採点項目（各20点満点）
1. **【権威性】**: 「選ぶ側」のスタンス維持、相手からの敬意。
2. **【損失回避】**: 現状維持のリスク指摘、相手の焦り（V字回復）。
3. **【リフレーミング】**: 「スクール」→「社内研修」への定義変更と納得感。
4. **【アンカリング】**: 費用を「覚悟のフィルター」と定義し、安く感じさせたか。
5. **【クロージング】**: 「手続き進めます」と言い切り、相手を誘導できたか。

# リード温度感の評価
Meta広告流入リードの特徴を踏まえ、以下も評価に反映：
* 広告で刺さったポイントを商談内で深掘りできているか
* リードの課題感・緊急度を正しく把握できているか
* 「なんとなく興味がある」段階から「今やらなきゃ」に引き上げられたか

# 出力フォーマット（JSON）
{
  "negotiation_result": "成約 OR トスアップ成功 OR 保留 OR 失注",
  "score": "合計点数（数値のみ）",
  "sub_scores": {
    "authority": "権威性(0-20)",
    "loss_aversion": "損失回避(0-20)",
    "reframing": "リフレーミング(0-20)",
    "anchoring": "アンカー(0-20)",
    "closing": "クロージング(0-20)"
  },
  "lead_temperature": "高 OR 中 OR 低（リードの初期温度感）",
  "temperature_change": "上昇 OR 維持 OR 下降（商談後の温度変化）",
  "best_phrase": "最も効果的だった営業担当者のセリフ（なければ空欄）",
  "bad_cause": "最大の減点要因（一言で）",
  "diagnosis_summary": "辛口な総評（改行は\\nで）",
  "good_points": [
    {
      "step": "項目名",
      "phrase": "発言抜粋",
      "logic": "解説"
    }
  ],
  "critical_advice": {
    "step": "最重要改善項目",
    "issue": "理由",
    "option_a_polish": { "strategy": "戦略A", "script": "トークA" },
    "option_b_alternative": { "strategy": "戦略B", "script": "トークB" }
  }
}
`;

// ==========================================
// 2. メイン処理：Google Drive監視モード
// ==========================================
function monitorAllFolders() {
  const now = new Date();
  const timeLimit = new Date(now.getTime() - (CHECK_MINUTES * 60 * 1000));
  const scriptProperties = PropertiesService.getScriptProperties();
  const processedFiles = JSON.parse(scriptProperties.getProperty('PROCESSED_FILES') || '{}');
  let newProcessedFiles = { ...processedFiles };
  let hasUpdate = false;

  console.log("--- 監視開始 ---");

  TARGETS.forEach(target => {
    if (!target || !target.folderId) return;

    try {
      const folder = DriveApp.getFolderById(target.folderId);
      const files = folder.getFiles();

      while (files.hasNext()) {
        const file = files.next();
        const fileName = file.getName();
        const fileId = file.getId();

        // 1. 基本チェック
        if (file.getLastUpdated() < timeLimit) continue;
        if (processedFiles[fileId]) continue;
        if (file.getMimeType() !== MimeType.GOOGLE_DOCS) continue;

        // 2. テキスト取得
        let text = extractTextSafely(fileId);
        if (!text) {
          console.error(`❌ テキスト抽出不可: ${fileName}`);
          continue;
        }
        if (text.length > MAX_CHAR_LIMIT) text = text.substring(0, MAX_CHAR_LIMIT);
        if (text.length < 200) continue;

        // 3. キーワード判定
        const isTitleMatch = TITLE_KEYWORDS.some(k => fileName.includes(k));
        const isContentMatch = CONTENT_KEYWORDS.some(k => text.includes(k));
        if (!isTitleMatch && !isContentMatch) continue;

        // 4. 録画URL抽出（Notta/Zoomドキュメントから）
        const recordingUrl = extractRecordingUrl(text, fileId);

        console.log(`🚀 分析開始: ${fileName}`);

        // 5. AI分析
        const result = callGeminiAPI(text);
        if (result) {
          sendToSlack(result, fileName, file.getUrl(), recordingUrl, target);
          saveToSheet(result, fileName, file.getUrl(), recordingUrl, target);
          newProcessedFiles[fileId] = now.getTime();
          hasUpdate = true;
          console.log("✅ 完了: " + fileName);
        }
      }
    } catch (e) {
      console.error(`エラー(${target.name}): ${e.message}`);
    }
  });

  if (hasUpdate) {
    // 24時間以上前の処理済みファイルをクリーンアップ
    const oneDayAgo = now.getTime() - (24 * 60 * 60 * 1000);
    for (const id in newProcessedFiles) {
      if (newProcessedFiles[id] < oneDayAgo) delete newProcessedFiles[id];
    }
    scriptProperties.setProperty('PROCESSED_FILES', JSON.stringify(newProcessedFiles));
    try { analyzeScores(); } catch (e) { console.error("レポート更新失敗:", e); }
  }
}

// ==========================================
// 3. メイン処理：Notta APIモード（契約後に有効化）
// ==========================================
function monitorNotta() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('NOTTA_API_KEY');
  if (!apiKey) {
    console.log("⚠️ Notta APIキー未設定。monitorAllFolders() を使用してください。");
    return;
  }

  const scriptProperties = PropertiesService.getScriptProperties();
  const processedNotta = JSON.parse(scriptProperties.getProperty('PROCESSED_NOTTA') || '{}');
  let hasUpdate = false;

  const transcripts = fetchNottaTranscripts_(apiKey);

  transcripts.forEach(t => {
    if (processedNotta[t.id]) return;

    const detail = getNottaTranscriptDetail_(apiKey, t.id);
    if (!detail || !detail.text || detail.text.length < 200) return;

    // 担当者マッチング
    const target = matchTarget_(detail.participants || [], t.title || "");
    if (!target) return;

    let text = detail.text;
    if (text.length > MAX_CHAR_LIMIT) text = text.substring(0, MAX_CHAR_LIMIT);

    const recordingUrl = detail.recording_url || detail.audio_url || "";

    console.log(`🚀 Notta分析開始: ${t.title}`);

    const result = callGeminiAPI(text);
    if (result) {
      const nottaUrl = detail.share_url || `https://app.notta.ai/transcript/${t.id}`;
      sendToSlack(result, t.title, nottaUrl, recordingUrl, target);
      saveToSheet(result, t.title, nottaUrl, recordingUrl, target);
      processedNotta[t.id] = new Date().getTime();
      hasUpdate = true;
      console.log("✅ Notta完了: " + t.title);
    }
  });

  if (hasUpdate) {
    const weekAgo = new Date().getTime() - (7 * 24 * 60 * 60 * 1000);
    for (const id in processedNotta) {
      if (processedNotta[id] < weekAgo) delete processedNotta[id];
    }
    scriptProperties.setProperty('PROCESSED_NOTTA', JSON.stringify(processedNotta));
    try { analyzeScores(); } catch (e) { console.error("レポート更新失敗:", e); }
  }
}

// ==========================================
// 4. テキスト抽出（録画付きドキュメント対応）
// ==========================================
function extractTextSafely(fileId) {
  try {
    // 方法A：通常の方法
    return DocumentApp.openById(fileId).getBody().getText();
  } catch (e) {
    try {
      // 方法B：Drive API強制エクスポート（録画タブ問題を突破）
      const url = "https://www.googleapis.com/drive/v3/files/" + fileId + "/export?mimeType=text/plain";
      const token = ScriptApp.getOAuthToken();
      const response = UrlFetchApp.fetch(url, {
        headers: { "Authorization": "Bearer " + token },
        muteHttpExceptions: true
      });
      if (response.getResponseCode() === 200) {
        return response.getContentText();
      } else {
        throw new Error("APIレスポンスエラー: " + response.getResponseCode());
      }
    } catch (driveError) {
      console.error("テキスト抽出失敗:", driveError.message);
    }
  }
  return null;
}

// ==========================================
// 5. 録画URL抽出
// ==========================================
function extractRecordingUrl(text, fileId) {
  // テキスト内のURLパターンを検索
  const patterns = [
    /https?:\/\/[^\s<>"]*notta\.ai[^\s<>"]*/i,
    /https?:\/\/[^\s<>"]*zoom\.us\/rec[^\s<>"]*/i,
    /https?:\/\/[^\s<>"]*zoom\.us\/recording[^\s<>"]*/i,
    /https?:\/\/[^\s<>"]*recording[^\s<>"]*/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }

  // Google Docsのハイパーリンクからも検索
  try {
    const doc = DocumentApp.openById(fileId);
    const body = doc.getBody();
    const numChildren = body.getNumChildren();

    for (let i = 0; i < numChildren; i++) {
      const child = body.getChild(i);
      if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
        const paragraph = child.asParagraph();
        const textContent = paragraph.getText();
        const numChars = textContent.length;
        for (let j = 0; j < numChars; j++) {
          try {
            const url = paragraph.getLinkUrl(j);
            if (url && (url.includes('notta') || url.includes('zoom.us/rec') || url.includes('recording'))) {
              return url;
            }
          } catch (e) { /* skip */ }
        }
      }
    }
  } catch (e) { /* skip */ }

  return "";
}

// ==========================================
// 6. Notta API ヘルパー（内部関数）
// ==========================================
function fetchNottaTranscripts_(apiKey) {
  try {
    const response = UrlFetchApp.fetch("https://api.notta.ai/v1/transcripts", {
      headers: { "Authorization": "Bearer " + apiKey },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      return data.transcripts || data.data || [];
    }
  } catch (e) {
    console.error("Notta API Error:", e.message);
  }
  return [];
}

function getNottaTranscriptDetail_(apiKey, transcriptId) {
  try {
    const response = UrlFetchApp.fetch(`https://api.notta.ai/v1/transcripts/${transcriptId}`, {
      headers: { "Authorization": "Bearer " + apiKey },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      return JSON.parse(response.getContentText());
    }
  } catch (e) {
    console.error("Notta Detail Error:", e.message);
  }
  return null;
}

function matchTarget_(participants, title) {
  for (const target of TARGETS) {
    if (!target) continue;
    if (title.includes(target.name)) return target;
    if (participants.some(p => (p.name || p || "").includes(target.name))) return target;
  }
  return TARGETS[0] || null;
}

// ==========================================
// 7. Gemini API
// ==========================================
function callGeminiAPI(transcriptText) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    console.error("❌ GEMINI_API_KEYが設定されていません");
    return null;
  }

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: AI_INSTRUCTION + "\n\n【商談ログ】\n" + transcriptText }]
    }],
    generationConfig: { responseMimeType: "application/json" }
  };

  try {
    const response = UrlFetchApp.fetch(apiUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const json = JSON.parse(response.getContentText());
    if (json.candidates && json.candidates[0].content) {
      let raw = json.candidates[0].content.parts[0].text;
      raw = raw.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(raw);
    } else {
      console.error("Gemini応答異常:", JSON.stringify(json).substring(0, 500));
    }
  } catch (e) {
    console.error("Gemini API Error:", e);
  }
  return null;
}

// ==========================================
// 8. Slack通知（録画URL・リード温度感・スコアバー追加）
// ==========================================
function sendToSlack(data, fileName, fileUrl, recordingUrl, target) {
  const score = parseInt(data.score || 0);
  let color = score >= 85 ? "#FFD700" : (score >= 75 ? "#36a64f" : (score >= 65 ? "#FFA500" : "#ff0000"));
  let emoji = score >= 85 ? "🏆" : (score >= 75 ? "✅" : (score >= 65 ? "🔶" : "🚨"));
  let mention = target.slackId ? `<@${target.slackId}>` : target.name;

  if (score >= 85) mention += " <!here> 神商談発生！";

  // 判定絵文字
  let resultEmoji = "❓";
  if (data.negotiation_result?.includes("成約") || data.negotiation_result?.includes("トスアップ")) {
    resultEmoji = "㊗️ 成約/トスアップ";
  } else if (data.negotiation_result?.includes("保留")) {
    resultEmoji = "🤔 保留";
  } else {
    resultEmoji = "😭 失注";
  }

  // スコアバー生成
  const subs = data.sub_scores || {};
  const scoreBar = (val) => {
    const v = parseInt(val) || 0;
    const filled = Math.round(v / 20 * 5);
    return "█".repeat(filled) + "░".repeat(5 - filled) + ` ${v}/20`;
  };

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `${emoji} 商談分析: ${score}点`, emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `👤 担当: ${mention} | 📄 <${fileUrl}|${fileName}>` }] },
    { type: "section", text: { type: "mrkdwn", text: `*判定:* *${resultEmoji}*` } }
  ];

  // 録画URLがあれば表示
  if (recordingUrl) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `🎥 <${recordingUrl}|録画を見る>` } });
  }

  // リード温度感（Meta広告分析用）
  if (data.lead_temperature) {
    const tempEmoji = data.lead_temperature === "高" ? "🔥" : (data.lead_temperature === "中" ? "🌡️" : "🧊");
    const changeEmoji = data.temperature_change === "上昇" ? "📈" : (data.temperature_change === "下降" ? "📉" : "➡️");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*リード温度:* ${tempEmoji} ${data.lead_temperature} ${changeEmoji} ${data.temperature_change}` }
    });
  }

  // スコア内訳（バー表示）
  blocks.push(
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*📊 スコア内訳*\n` +
          `権威性　　: ${scoreBar(subs.authority)}\n` +
          `損失回避　: ${scoreBar(subs.loss_aversion)}\n` +
          `リフレーミング: ${scoreBar(subs.reframing)}\n` +
          `アンカー　: ${scoreBar(subs.anchoring)}\n` +
          `クロージング: ${scoreBar(subs.closing)}`
      }
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*💬 総評*\n${data.diagnosis_summary}` } }
  );

  // Good Points
  if (data.good_points?.length) {
    blocks.push(
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: "*🔍 Good Points*" } }
    );
    data.good_points.forEach(p => {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `✅ *${p.step}*\n${p.logic}\n> 🗣️ "${p.phrase}"` }
      });
    });
  }

  // Critical Advice
  if (data.critical_advice) {
    const adv = data.critical_advice;
    blocks.push(
      { type: "divider" },
      { type: "header", text: { type: "plain_text", text: `🛠 改善点: ${adv.step}`, emoji: true } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *課題:* ${adv.issue}\n\n` +
            `*🅰️ 案A:* ${adv.option_a_polish?.script || ""}\n\n` +
            `*🅱️ 案B:* ${adv.option_b_alternative?.script || ""}`
        }
      }
    );
  }

  try {
    UrlFetchApp.fetch(SLACK_WEBHOOK_URL, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ attachments: [{ color: color, blocks: blocks }] })
    });
  } catch (e) { console.error("Slack送信エラー:", e); }
}

// ==========================================
// 9. Sheets保存（録画URL・リード温度感列追加）
// ==========================================
function saveToSheet(data, fileName, fileUrl, recordingUrl, target) {
  if (!SPREADSHEET_ID) return;

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName("商談ログ");
    if (!sheet) {
      // 既存シートがあればリネーム、なければ作成
      const existing = ss.getSheets()[0];
      if (existing.getLastRow() === 0) {
        existing.setName("商談ログ");
        sheet = existing;
      } else {
        sheet = ss.insertSheet("商談ログ");
      }
    }

    const today = Utilities.formatDate(new Date(), "JST", "yyyy/MM/dd HH:mm");

    // ヘッダー設定（初回のみ）
    if (sheet.getLastRow() === 0) {
      const headers = [
        "日時", "担当者", "ファイル名", "結果",
        "合計点", "権威性", "損失回避", "リフレーミング", "アンカー", "クロージング",
        "リード温度", "温度変化",
        "勝因", "敗因", "総評",
        "文字起こしURL", "録画URL"
      ];
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length)
        .setFontWeight("bold")
        .setBackground("#4a86c8")
        .setFontColor("#ffffff");
      sheet.setFrozenRows(1);
      // 列幅調整
      sheet.setColumnWidth(3, 250);  // ファイル名
      sheet.setColumnWidth(13, 250); // 勝因
      sheet.setColumnWidth(14, 250); // 敗因
      sheet.setColumnWidth(15, 400); // 総評
      sheet.setColumnWidth(16, 300); // URL
      sheet.setColumnWidth(17, 300); // 録画URL
    }

    const subs = data.sub_scores || {};
    const rowData = [
      today,
      target.name,
      fileName,
      data.negotiation_result || "-",
      data.score,
      subs.authority || "-",
      subs.loss_aversion || "-",
      subs.reframing || "-",
      subs.anchoring || "-",
      subs.closing || "-",
      data.lead_temperature || "-",
      data.temperature_change || "-",
      data.best_phrase || "-",
      data.bad_cause || "-",
      data.diagnosis_summary || "",
      fileUrl,
      recordingUrl || ""
    ];

    sheet.appendRow(rowData);

    // スコアに応じた行の色付け
    const lastRow = sheet.getLastRow();
    const score = parseInt(data.score || 0);
    if (score >= 85) {
      sheet.getRange(lastRow, 5).setBackground("#FFD700"); // 金
    } else if (score >= 75) {
      sheet.getRange(lastRow, 5).setBackground("#C6EFCE"); // 緑
    } else if (score < 65) {
      sheet.getRange(lastRow, 5).setBackground("#FFC7CE"); // 赤
    }

    // 結果に応じた色付け
    const result = data.negotiation_result || "";
    if (result.includes("成約") || result.includes("トスアップ")) {
      sheet.getRange(lastRow, 4).setBackground("#C6EFCE").setFontWeight("bold");
    } else if (result.includes("失注")) {
      sheet.getRange(lastRow, 4).setBackground("#FFC7CE");
    }

    console.log("📊 シート保存完了");
  } catch (e) { console.error("シート保存エラー:", e); }
}

// ==========================================
// 10. レポート生成
// ==========================================
function analyzeScores() {
  if (!SPREADSHEET_ID) return;

  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const logSheet = ss.getSheetByName("商談ログ") || ss.getSheets()[0];
    if (logSheet.getLastRow() < 2) return;

    const logData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, logSheet.getLastColumn()).getValues();

    const skillNames = ["権威性", "損失回避", "リフレーミング", "アンカー", "クロージング"];
    // カラムインデックス（0始まり）
    const COL = {
      DATE: 0, NAME: 1, FILE: 2, RESULT: 3,
      SCORE: 4, AUTH: 5, LOSS: 6, REFRAME: 7, ANCHOR: 8, CLOSE: 9,
      LEAD_TEMP: 10, TEMP_CHANGE: 11,
      BEST: 12, BAD: 13
    };
    const skillCols = [COL.AUTH, COL.LOSS, COL.REFRAME, COL.ANCHOR, COL.CLOSE];

    const monthlySummary = {};
    const trendSummary = {};

    logData.forEach(row => {
      if (!row[COL.DATE]) return;
      try {
        const date = new Date(row[COL.DATE]);
        const name = row[COL.NAME];
        const result = row[COL.RESULT];
        const totalScore = parseInt(row[COL.SCORE]) || 0;
        const isWin = (result?.includes('成約') || result?.includes('トスアップ'));
        const leadTemp = row[COL.LEAD_TEMP] || "-";

        const monthKey = Utilities.formatDate(date, "JST", "yyyyMM") + "_" + (date.getMonth() + 1) + "月";
        const weekKey = Utilities.formatDate(date, "JST", "yyyy/MM") + " 週" + Math.ceil(date.getDate() / 7);
        const trendMonthKey = Utilities.formatDate(date, "JST", "yyyy年MM月");

        const skillScores = skillCols.map(i => parseInt(row[i]) || 0);
        const bestPhrase = row[COL.BEST];
        const badCause = row[COL.BAD];

        // 月別集計
        if (!monthlySummary[monthKey]) monthlySummary[monthKey] = {};
        if (!monthlySummary[monthKey][name]) {
          monthlySummary[monthKey][name] = {
            count: 0, total: 0, win: 0, skills: [0, 0, 0, 0, 0],
            phrases: [], causes: [],
            leadTemps: { "高": 0, "中": 0, "低": 0 },
            winByTemp: { "高": 0, "中": 0, "低": 0 }
          };
        }
        const mRec = monthlySummary[monthKey][name];
        mRec.count++;
        mRec.total += totalScore;
        if (isWin) mRec.win++;
        skillScores.forEach((s, i) => mRec.skills[i] += s);
        if (bestPhrase && bestPhrase !== '-') mRec.phrases.push(bestPhrase);
        if (badCause && badCause !== '-') mRec.causes.push(badCause);
        if (leadTemp in mRec.leadTemps) {
          mRec.leadTemps[leadTemp]++;
          if (isWin) mRec.winByTemp[leadTemp]++;
        }

        // 推移集計
        if (!trendSummary[name]) trendSummary[name] = { weekly: {}, monthly: {} };
        const addTrend = (obj, key) => {
          if (!obj[key]) obj[key] = { count: 0, total: 0, win: 0, skills: [0, 0, 0, 0, 0] };
          obj[key].count++;
          obj[key].total += totalScore;
          if (isWin) obj[key].win++;
          skillScores.forEach((s, i) => obj[key].skills[i] += s);
        };
        addTrend(trendSummary[name].weekly, weekKey);
        addTrend(trendSummary[name].monthly, trendMonthKey);

      } catch (e) { console.warn("Row skip:", e); }
    });

    writeMonthlyReport_(ss, monthlySummary, skillNames);
    writeTrendReport_(ss, trendSummary, skillNames);
    writeLeadReport_(ss, monthlySummary);

    console.log("✅ レポート更新完了");
  } catch (e) { console.error("レポートエラー:", e); }
}

// ==========================================
// 11. レポート出力関数
// ==========================================

// ユーティリティ
function getTopK_(arr) {
  if (!arr || !arr.length) return "-";
  const c = arr.reduce((a, b) => (a[b] = (a[b] || 0) + 1, a), {});
  return Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 3).join(' / ');
}

function getSheet_(ss, name) {
  let s = ss.getSheetByName(name);
  if (!s) s = ss.insertSheet(name);
  else s.clear();
  return s;
}

// スキル別月次レポート
function writeMonthlyReport_(ss, summary, skillNames) {
  const sheet = getSheet_(ss, 'レポート_スキル別平均');
  const headers = ['月', '担当者', '件数', '成約率', '平均点', ...skillNames.map(n => n + ' 平均'), '長所', '課題'];
  const data = [];

  Object.keys(summary).sort().reverse().forEach(mKey => {
    const label = mKey.split("_")[1];
    const mData = summary[mKey];
    Object.keys(mData).sort().forEach(name => {
      const r = mData[name];
      data.push([
        label, name, r.count,
        (r.win / r.count * 100).toFixed(1) + '%',
        (r.total / r.count).toFixed(1),
        ...r.skills.map(s => (s / r.count).toFixed(1)),
        getTopK_(r.phrases),
        getTopK_(r.causes)
      ]);
    });
  });

  sheet.appendRow(headers);
  if (data.length) sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#c9daf8");
  sheet.setFrozenRows(1);
  try {
    sheet.setColumnWidth(headers.length - 1, 300);
    sheet.setColumnWidth(headers.length, 300);
  } catch (e) { }
  if (data.length) {
    sheet.getRange(2, 1, data.length, headers.length).setWrap(true).setVerticalAlignment("top");
  }
}

// 個人別推移レポート
function writeTrendReport_(ss, summary, skillNames) {
  const headers = ['期間', '商談数', '成約率', '平均点', ...skillNames];

  Object.keys(summary).forEach(name => {
    const sheet = getSheet_(ss, 'レポート_推移 ' + name);
    let row = 1;

    // 週次
    sheet.getRange(row, 1, 1, headers.length).setValues([headers])
      .setFontWeight("bold").setBackground("#fce5cd");
    row++;

    const wKeys = Object.keys(summary[name].weekly).sort();
    wKeys.forEach(k => {
      const r = summary[name].weekly[k];
      sheet.getRange(row, 1, 1, headers.length).setValues([[
        k, r.count,
        r.count > 0 ? (r.win / r.count * 100).toFixed(1) + '%' : '-',
        r.count > 0 ? (r.total / r.count).toFixed(1) : '-',
        ...r.skills.map(s => r.count > 0 ? (s / r.count).toFixed(1) : '-')
      ]]);
      row++;
    });

    row += 2;

    // 月次
    sheet.getRange(row, 1, 1, headers.length).setValues([headers])
      .setFontWeight("bold").setBackground("#d9ead3");
    row++;

    const mKeys = Object.keys(summary[name].monthly).sort();
    mKeys.forEach(k => {
      const r = summary[name].monthly[k];
      sheet.getRange(row, 1, 1, headers.length).setValues([[
        k, r.count,
        r.count > 0 ? (r.win / r.count * 100).toFixed(1) + '%' : '-',
        r.count > 0 ? (r.total / r.count).toFixed(1) : '-',
        ...r.skills.map(s => r.count > 0 ? (s / r.count).toFixed(1) : '-')
      ]]);
      row++;
    });

    sheet.autoResizeColumns(1, headers.length);
  });
}

// リード温度別レポート（Meta広告効果分析用）
function writeLeadReport_(ss, summary) {
  const sheet = getSheet_(ss, 'レポート_リード分析');
  const headers = [
    '月', '担当者',
    '🔥高温リード数', '高温成約率',
    '🌡️中温リード数', '中温成約率',
    '🧊低温リード数', '低温成約率',
    '全体成約率'
  ];
  const data = [];

  Object.keys(summary).sort().reverse().forEach(mKey => {
    const label = mKey.split("_")[1];
    const mData = summary[mKey];
    Object.keys(mData).sort().forEach(name => {
      const r = mData[name];
      const temps = r.leadTemps || { "高": 0, "中": 0, "低": 0 };
      const wins = r.winByTemp || { "高": 0, "中": 0, "低": 0 };
      data.push([
        label, name,
        temps["高"], temps["高"] > 0 ? (wins["高"] / temps["高"] * 100).toFixed(1) + '%' : '-',
        temps["中"], temps["中"] > 0 ? (wins["中"] / temps["中"] * 100).toFixed(1) + '%' : '-',
        temps["低"], temps["低"] > 0 ? (wins["低"] / temps["低"] * 100).toFixed(1) + '%' : '-',
        r.count > 0 ? (r.win / r.count * 100).toFixed(1) + '%' : '-'
      ]);
    });
  });

  sheet.appendRow(headers);
  if (data.length) sheet.getRange(2, 1, data.length, headers.length).setValues(data);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#f4cccc");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
}

// ==========================================
// 12. 初期セットアップ（初回のみ実行）
// ==========================================
function initialSetup() {
  // 既存トリガーチェック
  const triggers = ScriptApp.getProjectTriggers();
  const hasMonitorTrigger = triggers.some(t => t.getHandlerFunction() === 'monitorAllFolders');

  if (!hasMonitorTrigger) {
    ScriptApp.newTrigger('monitorAllFolders')
      .timeBased()
      .everyMinutes(15)
      .create();
    console.log("✅ 15分間隔トリガー設定完了（monitorAllFolders）");
  } else {
    console.log("ℹ️ monitorAllFoldersトリガーは既に設定済み");
  }

  // APIキー確認
  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty('GEMINI_API_KEY');
  const nottaKey = props.getProperty('NOTTA_API_KEY');

  console.log("========================================");
  console.log("📋 セットアップ状況:");
  console.log("========================================");
  console.log(`Gemini API Key: ${geminiKey ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`Notta API Key:  ${nottaKey ? '✅ 設定済み' : '⏳ 未設定（契約後に設定）'}`);
  console.log(`Slack Webhook:  ${SLACK_WEBHOOK_URL ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`Spreadsheet ID: ${SPREADSHEET_ID ? '✅ 設定済み' : '❌ 未設定'}`);
  console.log(`監視対象: ${TARGETS.filter(t => t).length}名`);
  TARGETS.filter(t => t).forEach(t => console.log(`  - ${t.name} (${t.folderId ? '✅' : '❌'})`));
  console.log("========================================");
  console.log("");
  console.log("📌 次のステップ:");
  if (!geminiKey) console.log("  1. スクリプトプロパティに GEMINI_API_KEY を設定");
  console.log("  2. testWithSampleData() でSlack/Sheets動作確認");
  console.log("  3. Notta契約後 → NOTTA_API_KEY を設定");
  console.log("  4. Notta契約後 → トリガーを monitorNotta に切替");
}

// Notta切替用：トリガーをmonitorNottaに変更
function switchToNottaMode() {
  const triggers = ScriptApp.getProjectTriggers();

  // 既存のmonitorAllFoldersトリガーを削除
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'monitorAllFolders') {
      ScriptApp.deleteTrigger(t);
      console.log("🔄 monitorAllFolders トリガー削除");
    }
  });

  // monitorNottaトリガーを作成
  const hasNottaTrigger = triggers.some(t => t.getHandlerFunction() === 'monitorNotta');
  if (!hasNottaTrigger) {
    ScriptApp.newTrigger('monitorNotta')
      .timeBased()
      .everyMinutes(15)
      .create();
    console.log("✅ monitorNotta トリガー設定完了");
  }

  console.log("🚀 Nottaモードに切替完了！");
}

// ==========================================
// 13. テスト・デバッグ
// ==========================================

// サンプルデータでSlack+Sheetsのテスト
function testWithSampleData() {
  const sampleResult = {
    negotiation_result: "トスアップ成功",
    score: 78,
    sub_scores: {
      authority: 16,
      loss_aversion: 15,
      reframing: 17,
      anchoring: 14,
      closing: 16
    },
    lead_temperature: "中",
    temperature_change: "上昇",
    best_phrase: "今のままだと半年後に競合に抜かれますよ",
    bad_cause: "クロージング時の沈黙が長すぎた",
    diagnosis_summary: "全体的に安定した商談。特にリフレーミングが効いていた。\nただしクロージングで一瞬迷いが見えた。\nMeta広告経由で中温度のリードだが、損失回避で温度を引き上げられた。",
    good_points: [
      {
        step: "リフレーミング",
        phrase: "これはスクールではなく、御社専用の研修プログラムです",
        logic: "定義変更によって価格への抵抗感を軽減。Meta広告で見た印象を上回る価値提案ができた"
      },
      {
        step: "損失回避",
        phrase: "今のままだと半年後に競合に抜かれますよ",
        logic: "現状維持のリスクを具体的に提示し、焦りを生み出した"
      }
    ],
    critical_advice: {
      step: "クロージング",
      issue: "最後の一押しに迷いが見えた。沈黙の使い方を改善すべき",
      option_a_polish: {
        strategy: "沈黙活用型",
        script: "では、手続き進めますね。（3秒沈黙）…よろしいですか？"
      },
      option_b_alternative: {
        strategy: "限定性訴求型",
        script: "今月中であれば特別枠でご案内できますが、いかがですか？"
      }
    }
  };

  const target = TARGETS[0];
  if (!target) {
    console.error("❌ TARGETSが空です");
    return;
  }

  console.log("📊 テストデータでSlack送信テスト...");
  sendToSlack(sampleResult, "【テスト】Meta広告流入_サンプル商談", "https://docs.google.com/document/d/test", "https://zoom.us/rec/share/test-recording", target);

  console.log("📊 テストデータでSheets保存テスト...");
  saveToSheet(sampleResult, "【テスト】Meta広告流入_サンプル商談", "https://docs.google.com/document/d/test", "https://zoom.us/rec/share/test-recording", target);

  console.log("✅ テスト完了 - Slackとシートを確認してください");
}

// 手動で特定ファイルを分析
function analyzeSpecificFile() {
  // ▼ ここにGoogle DocsのファイルIDを入力 ▼
  const FILE_ID = "ここにファイルIDを入力";
  const TARGET_NAME = "高橋"; // 担当者名
  // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

  const target = TARGETS.find(t => t && t.name === TARGET_NAME) || TARGETS[0];
  const file = DriveApp.getFileById(FILE_ID);
  const fileName = file.getName();

  let text = extractTextSafely(FILE_ID);
  if (!text) {
    console.error("❌ テキスト抽出不可");
    return;
  }
  if (text.length > MAX_CHAR_LIMIT) text = text.substring(0, MAX_CHAR_LIMIT);

  const recordingUrl = extractRecordingUrl(text, FILE_ID);

  console.log(`🚀 手動分析開始: ${fileName} (${text.length}文字)`);

  const result = callGeminiAPI(text);
  if (result) {
    console.log("📊 結果:", JSON.stringify(result, null, 2));
    sendToSlack(result, fileName, file.getUrl(), recordingUrl, target);
    saveToSheet(result, fileName, file.getUrl(), recordingUrl, target);
    console.log("✅ 完了");
  } else {
    console.error("❌ AI分析失敗");
  }
}
