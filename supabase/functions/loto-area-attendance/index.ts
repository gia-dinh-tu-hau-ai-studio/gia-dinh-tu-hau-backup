import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const bucket = "loto-area-attendance";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { ...cors, "Content-Type": "application/json" } });
const vnDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
const vnMinutes = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
};

async function signedAttendanceUrls(admin: any, row: any, kind: "check-in" | "check-out") {
  const prefix = `${row.business_id}/${row.venue_id}/${row.work_date}`;
  const { data: objects, error: listError } = await admin.storage
    .from(bucket)
    .list(prefix, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
  if (listError) throw listError;

  const paths = (objects || [])
    .filter((item: any) => item.name?.startsWith(`${kind}-`))
    .map((item: any) => `${prefix}/${item.name}`);
  const legacyPath = row[kind === "check-in" ? "check_in_photo_path" : "check_out_photo_path"];
  if (!paths.length && legacyPath) paths.push(legacyPath);
  if (!paths.length) return [];

  const { data: signed, error: signedError } = await admin.storage.from(bucket).createSignedUrls(paths, 3600);
  if (signedError) throw signedError;
  return (signed || []).map((item: any) => item.signedUrl).filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const token = auth.replace(/^Bearer\s+/, "");
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: { user } } = await userClient.auth.getUser(token);
    if (!user) return json({ error: "Bạn chưa đăng nhập." }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin.from("profiles").select("business_id,role,venue_id")
      .eq("user_id", user.id).single();
    if (!profile || !["owner", "manager"].includes(profile.role)) {
      return json({ error: "Chỉ quản lý khu hoặc chủ sở hữu được sử dụng." }, 403);
    }

    const contentType = req.headers.get("content-type") || "";
    let input: any = {};
    let file: File | null = null;
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      input = Object.fromEntries(form.entries());
      file = form.get("photo") instanceof File ? form.get("photo") as File : null;
    } else input = await req.json().catch(() => ({}));

    const action = String(input.action || "list");
    const venueId = Number(input.venue_id || profile.venue_id);
    const workDate = String(input.work_date || vnDate());

    if (action === "list") {
      const start = String(input.start || `${workDate.slice(0, 7)}-01`);
      const end = String(input.end || workDate);
      let query = admin.from("loto_area_attendance")
        .select("*,venue:venues(name),manager:profiles!loto_area_attendance_manager_user_id_fkey(full_name)")
        .eq("business_id", profile.business_id).gte("work_date", start).lte("work_date", end)
        .order("work_date", { ascending: false });
      if (venueId) query = query.eq("venue_id", venueId);
      const { data, error } = await query;
      if (error) throw error;
      const rows = await Promise.all((data || []).map(async (row: any) => ({
        ...row,
        check_in_photo_urls: await signedAttendanceUrls(admin, row, "check-in"),
        check_out_photo_urls: await signedAttendanceUrls(admin, row, "check-out"),
      })));
      return json({ ok: true, rows });
    }

    if (action === "review") {
      if (profile.role !== "owner") return json({ error: "Chỉ chủ sở hữu được duyệt lý do đi trễ." }, 403);
      const id = Number(input.id), decision = String(input.decision);
      if (!["approved", "rejected"].includes(decision)) return json({ error: "Quyết định không hợp lệ." }, 400);
      const { data: row } = await admin.from("loto_area_attendance").select("*").eq("id", id)
        .eq("business_id", profile.business_id).single();
      if (!row) return json({ error: "Không tìm thấy báo cáo." }, 404);
      let violation = 0, reminder = false, penalty = 0;
      if (decision === "rejected") {
        const monthStart = `${row.work_date.slice(0, 7)}-01`;
        const end = new Date(`${row.work_date}T12:00:00`); end.setMonth(end.getMonth() + 1, 1);
        const monthEnd = end.toISOString().slice(0, 10);
        const { count } = await admin.from("loto_area_attendance").select("id", { count: "exact", head: true })
          .eq("manager_user_id", row.manager_user_id).eq("approval_status", "rejected")
          .gte("work_date", monthStart).lt("work_date", monthEnd).neq("id", id);
        violation = Number(count || 0) + 1; reminder = violation === 1; penalty = violation >= 2 ? 500000 : 0;
        await admin.from("staff_notifications").insert({
          business_id: row.business_id, user_id: row.manager_user_id,
          title: reminder ? "Nhắc Nhở Check In Trễ" : "Thông Báo Phạt Check In Trễ",
          content: reminder ? "Đây là lần check in trễ không được duyệt đầu tiên trong tháng. Vui lòng thực hiện trước 18h." : `Lần check in trễ không được duyệt thứ ${violation} trong tháng, mức phạt 500.000 đồng.`,
          notification_type: reminder ? "reminder" : "penalty", related_entity: "loto_area_attendance", related_id: id,
        });
      }
      const { error } = await admin.from("loto_area_attendance").update({
        approval_status: decision, reviewed_by: user.id, reviewed_at: new Date().toISOString(),
        review_note: String(input.note || ""), monthly_violation_no: violation,
        reminder_sent: reminder, penalty_amount: penalty, updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) throw error;
      return json({ ok: true, message: decision === "approved" ? "Đã duyệt lý do, báo cáo được tính hợp lệ." : reminder ? "Đã từ chối và gửi nhắc nhở lần đầu." : "Đã từ chối và ghi nhận phạt 500.000 đồng." });
    }

    if (!venueId || !file) return json({ error: "Vui lòng chọn sân khấu và ảnh chụp." }, 400);
    if (profile.role === "manager" && profile.venue_id && Number(profile.venue_id) !== venueId) {
      return json({ error: "Bạn không được báo cáo cho sân khấu khác." }, 403);
    }
    const kind = action === "check_in" ? "check-in" : action === "check_out" ? "check-out" : "";
    if (!kind) return json({ error: "Thao tác không hợp lệ." }, 400);
    const late = kind === "check-in" && vnMinutes() > 18 * 60;
    const reason = String(input.late_reason || "").trim();
    if (late && !reason) return json({ error: "Check in sau 18h phải nhập lý do." }, 400);
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const path = `${profile.business_id}/${venueId}/${workDate}/${kind}-${Date.now()}.${ext}`;
    const { error: uploadError } = await admin.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) throw uploadError;
    const values = kind === "check-in" ? {
      business_id: profile.business_id, venue_id: venueId, work_date: workDate, manager_user_id: user.id,
      check_in_at: new Date().toISOString(), check_in_photo_path: path, is_late: late,
      late_reason: late ? reason : null, approval_status: late ? "pending" : "not_required", updated_at: new Date().toISOString(),
    } : {
      business_id: profile.business_id, venue_id: venueId, work_date: workDate, manager_user_id: user.id,
      check_out_at: new Date().toISOString(), check_out_photo_path: path, updated_at: new Date().toISOString(),
    };
    const { error } = await admin.from("loto_area_attendance").upsert(values, { onConflict: "venue_id,work_date" });
    if (error) { await admin.storage.from(bucket).remove([path]); throw error; }
    return json({ ok: true, message: late ? "Đã gửi Check In trễ, đang chờ duyệt lý do." : kind === "check-in" ? "Đã gửi ảnh Check In hợp lệ." : "Đã gửi ảnh Check Out." });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Lỗi hệ thống." }, 500);
  }
});
