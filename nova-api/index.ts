import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/* ---------- Telegram initData validation ---------- */
async function validateInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(BOT_TOKEN));

  const finalKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", finalKey, encoder.encode(dataCheckString));
  const hashHex = [...new Uint8Array(signature)]
    .map(b => b.toString(16).padStart(2, "0")).join("");

  if (hashHex !== hash) throw new Error("Invalid initData");

  const user = JSON.parse(params.get("user") || "{}");
  const startParam = params.get("start_param") || null;
  return { user, startParam };
}

/* ---------- Helpers ---------- */
async function getUser(telegramId: number) {
  const { data } = await supabase.from("users").select("*").eq("telegram_id", telegramId).single();
  return data;
}

async function ensureUser(user: any, startParam: string | null) {
  let { data } = await supabase.from("users").select("*").eq("telegram_id", user.id).single();
  if (!data) {
    let referredBy = null;
    if (startParam && startParam.startsWith("ref_")) {
      const refId = parseInt(startParam.replace("ref_", ""));
      if (refId !== user.id) referredBy = refId;
    }
    const { data: newUser } = await supabase.from("users").insert({
      telegram_id: user.id,
      username: user.username,
      first_name: user.first_name,
      referred_by: referredBy,
    }).select().single();
    data = newUser;
    if (referredBy) {
      await supabase.from("referrals").insert({
        referrer_id: referredBy,
        referred_id: user.id,
      }).select();
    }
  }
  return data;
}

async function tgAPI(method: string, body: any) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/* ---------- Actions ---------- */
async function handleAction(action: string, payload: any, user: any) {
  const uid = user.id;

  /* ---- DASHBOARD ---- */
  if (action === "dashboard") {
    const u = await getUser(uid);
    return { user: u };
  }

  /* ---- AD REWARD ---- */
  if (action === "ad_reward") {
    const { ad_token } = payload;
    if (!ad_token) throw new Error("Ad not verified");

    // 30 sec cooldown
    const { data: recent } = await supabase.from("ads_log")
      .select("*").eq("telegram_id", uid)
      .gte("created_at", new Date(Date.now() - 30000).toISOString())
      .limit(1);
    if (recent && recent.length > 0) throw new Error("Please wait 30 seconds");

    const reward = 0.015;
    await supabase.from("ads_log").insert({ telegram_id: uid, reward });

    const u = await getUser(uid);
    const newTotal = (u.ads_watched_total || 0) + 1;
    await supabase.from("users").update({
      balance: Number(u.balance) + reward,
      ads_watched_today: (u.ads_watched_today || 0) + 1,
      ads_watched_total: newTotal,
    }).eq("telegram_id", uid);

    // Referral bonus check
    let referral_bonus_paid = false;
    const u2 = await getUser(uid);
    if (u2.referred_by && newTotal === 10) {
      const { data: ref } = await supabase.from("referrals")
        .select("*").eq("referred_id", uid).single();
      if (ref && !ref.bonus_paid) {
        const { data: referrer } = await supabase.from("users")
          .select("balance, referral_count").eq("telegram_id", ref.referrer_id).single();
        if (referrer) {
          await supabase.from("users").update({
            balance: Number(referrer.balance) + 10,
            referral_count: (referrer.referral_count || 0) + 1,
          }).eq("telegram_id", ref.referrer_id);
          await supabase.from("referrals").update({ bonus_paid: true }).eq("referred_id", uid);
          try {
            await tgAPI("sendMessage", {
              chat_id: ref.referrer_id,
              text: "🎉 Referral Bonus!\nAapke referral ne 10 ads complete kiye. +10 NOVA mile!",
            });
          } catch (_) {}
          referral_bonus_paid = true;
        }
      }
    }
    return { ok: true, reward, referral_bonus_paid };
  }

  /* ---- TASKS ---- */
  if (action === "tasks_list") {
    const { data: tasks } = await supabase.from("tasks").select("*").eq("active", true);
    const { data: done } = await supabase.from("task_completions").select("task_id").eq("telegram_id", uid);
    const doneIds = (done || []).map((d: any) => d.task_id);
    return { tasks: tasks || [], completed: doneIds };
  }

  if (action === "task_complete") {
    const { task_id } = payload;
    const { data: task } = await supabase.from("tasks").select("*").eq("id", task_id).single();
    if (!task || !task.active) throw new Error("Task not found");

    const { data: already } = await supabase.from("task_completions")
      .select("*").eq("telegram_id", uid).eq("task_id", task_id).single();
    if (already) throw new Error("Task already completed");

    if (task.type === "channel" && task.chat_id) {
      const res = await tgAPI("getChatMember", { chat_id: task.chat_id, user_id: uid });
      if (!res.ok) throw new Error("Bot is not admin of that channel");
      const status = res.result?.status;
      if (status !== "member" && status !== "administrator" && status !== "creator") {
        throw new Error("Please join the channel first");
      }
    }

    await supabase.from("task_completions").insert({ telegram_id: uid, task_id });
    const u = await getUser(uid);
    await supabase.from("users").update({
      balance: Number(u.balance) + Number(task.reward),
    }).eq("telegram_id", uid);
    return { ok: true, reward: task.reward };
  }

  /* ---- MINING ---- */
  if (action === "mining_status") {
    const u = await getUser(uid);
    const now = Date.now();
    let canStart = true;
    let canCollect = false;
    let remaining = 0;

    if (u.mining_started_at && !u.mining_collected_at) {
      const startedAt = new Date(u.mining_started_at).getTime();
      const elapsedSec = (now - startedAt) / 1000;
      const totalSec = 60 * 60; // 60 minutes
      if (elapsedSec < totalSec) {
        canStart = false;
        remaining = Math.ceil(totalSec - elapsedSec);
      } else {
        canCollect = true;
      }
    }
    return { canStart, canCollect, remaining, balance: u.balance };
  }

  if (action === "mining_start") {
    const u = await getUser(uid);
    if (u.mining_started_at && !u.mining_collected_at) {
      const elapsedSec = (Date.now() - new Date(u.mining_started_at).getTime()) / 1000;
      if (elapsedSec < 3600) throw new Error("Mining already running");
    }
    await supabase.from("users").update({
      mining_started_at: new Date().toISOString(),
      mining_collected_at: null,
    }).eq("telegram_id", uid);
    return { ok: true };
  }

  if (action === "mining_collect") {
    const { ad_token } = payload;
    if (!ad_token) throw new Error("Ad must be watched to collect");

    const u = await getUser(uid);
    if (!u.mining_started_at) throw new Error("No mining session");
    const elapsedSec = (Date.now() - new Date(u.mining_started_at).getTime()) / 1000;
    if (elapsedSec < 3600) throw new Error("Mining not complete yet");
    if (u.mining_collected_at) throw new Error("Already collected");

    const reward = 0.1;
    await supabase.from("users").update({
      balance: Number(u.balance) + reward,
      mining_collected_at: new Date().toISOString(),
      mining_started_at: null,
    }).eq("telegram_id", uid);
    return { ok: true, reward };
  }

  /* ---- WITHDRAW ---- */
  if (action === "withdraw_info") {
    const u = await getUser(uid);
    const { data: history } = await supabase.from("withdrawals")
      .select("*").eq("telegram_id", uid)
      .order("created_at", { ascending: false }).limit(20);
    return { balance: u.balance, wallet: u.wallet, history: history || [], min: 100 };
  }

  if (action === "withdraw_request") {
    const { wallet } = payload;
    if (!wallet || wallet.length < 10) throw new Error("Invalid wallet");
    const u = await getUser(uid);
    if (Number(u.balance) < 100) throw new Error("Minimum 100 NOVA required");
    await supabase.from("users").update({ wallet }).eq("telegram_id", uid);
    await supabase.from("withdrawals").insert({
      telegram_id: uid, amount: u.balance, wallet,
    });
    await supabase.from("users").update({ balance: 0 }).eq("telegram_id", uid);
    return { ok: true };
  }

  if (action === "set_wallet") {
    const { wallet } = payload;
    if (!wallet || wallet.length < 10) throw new Error("Invalid wallet");
    await supabase.from("users").update({ wallet }).eq("telegram_id", uid);
    return { ok: true };
  }

  /* ---- REFERRAL ---- */
  if (action === "referral_info") {
    const u = await getUser(uid);
    const botInfo = await tgAPI("getMe", {});
    const botUsername = botInfo.result?.username || "YourBot";
    return {
      link: `https://t.me/${botUsername}?startapp=ref_${uid}`,
      count: u.referral_count || 0,
    };
  }

  throw new Error("Unknown action: " + action);
}

/* ---------- Main ---------- */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { initData, action, payload } = body;

    if (!initData) throw new Error("Missing initData");
    const { user, startParam } = await validateInitData(initData);
    await ensureUser(user, startParam);

    const result = await handleAction(action, payload || {}, user);

    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("Error:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
