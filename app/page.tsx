"use client";

import { type Session } from "@supabase/supabase-js";
import Image from "next/image";
import { type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { getOfflineTicketDraft, getPendingOfflineTicketDrafts, markOfflineTicketDraftSynced, putOfflineTicketDraft } from "./offline-ticket-store";
import ContractorWeeklyPayroll from "./contractor-weekly-payroll";
import { supabaseClient } from "./supabase-client";

// Production build marker: keep public Supabase configuration embedded in the client bundle.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const appsScriptSyncUrl = process.env.NEXT_PUBLIC_APPS_SCRIPT_SYNC_URL || "https://script.google.com/macros/s/AKfycbwBpWcHL5idx2X3m8XPPVZCLGCCaL6g2pm9TThRVJkDg0wTS0I-_RT0L4klD5ET5xfM5g/exec";

type MoneyInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string | number | null | undefined;
  onValueChange: (digits: string) => void;
};

function MoneyInput({ value, onValueChange, onFocus, onBlur, ...props }: MoneyInputProps) {
  const [editing, setEditing] = useState(false);
  const digits = String(value ?? "").replace(/\D/g, "");
  const displayValue = editing ? digits : digits ? Number(digits).toLocaleString("vi-VN") : "";
  return <input {...props} type="text" inputMode="numeric" value={displayValue}
    onFocus={event => { setEditing(true); onFocus?.(event); }}
    onBlur={event => { setEditing(false); onBlur?.(event); }}
    onChange={event => onValueChange(event.target.value.replace(/\D/g, ""))} />;
}

type Profile = { business_id: number; role: string; status: string; username: string | null; access_level: number; venue_id: number | null; employee_id:number|null; allowed_modules: string[]; must_change_password:boolean };
type Venue = { id: number; name: string; attendance_latitude?:number|null; attendance_longitude?:number|null; attendance_radius_m?:number; attendance_wifi_ips?:string[]; attendance_configured_at?:string|null };
type Employee = { id: number; full_name: string; is_active?:boolean; joined_on?:string|null; payroll_closing_day?:number; salary_payment_day?:number; weekly_payment_weekday?:number; responsibility_amount?:number; bonus_amount?:number; bonus_advance_eligible?:boolean; bonus_advance_limit?:number; responsibility_target_required?:boolean; weekly_hourly_rate?:number; weekly_salary?:number; weekend_hourly_rate?:number; holiday_hourly_rate?:number; daily_rate?:number; daily_weekend_rate?:number; daily_holiday_rate?:number; account_access_level?:number; account_venue_id?:number|null; job_title?:string|null; loto_role?:"organ"|"ticket_checker"|"performer"|null; weekday_case?: number; weekend_case?: number; holiday_case?: number; tet_case?: number; half_case?: number; department?:"loto"|"game"|"water"|"kiosk"|"office"|null; pay_type?:"monthly"|"hourly"|"weekly"|"daily"|null; monthly_salary?:number; hourly_rate?:number; attendance_enabled?:boolean; scheduling_level?:"A"|"B"|"C"|"D"; scheduling_symbol?:string|null; scheduling_note?:string|null };
type Shift = { id: number; business_id?: number; name: string; venue_id: number; opened_at: string; opened_by?: string; closed_by?: string; closed_at?: string; performance_date?: string; kinh_trung_amount?: number; status?: "open"|"closed" };
type ShiftPerson = { id: number; full_name: string; weekday_case: number; weekend_case: number; holiday_case: number; tet_case: number; half_case: number; support_100k: number; support_200k: number };
type TicketItem = { id: number; code: string; handover_quantity: number; gift_value: number };
const ticketCodeKey = (value:unknown) => {
  const code=String(value||"").trim();
  if(!/^\d+$/.test(code))return code.toLocaleLowerCase("vi");
  return code.replace(/^0+(?=\d)/,"");
};
const resolveTicketItem = (code:string,items:TicketItem[]) => {
  const exact=items.find(item=>item.code===code);
  if(exact)return exact;
  const key=ticketCodeKey(code);
  const matches=items.filter(item=>ticketCodeKey(item.code)===key);
  return matches.length===1?matches[0]:undefined;
};
type TicketRow = { id: string; codes: string[]; quantities: Record<number, string>; price: number; gift: string; rowColor?: "green" | "red" | "yellow" | "pink" | "purple"; promotionRole?: "sale" | "gift"; promotionGroupId?: string };
const normalizeTicketRowColor = (value:unknown):TicketRow["rowColor"] => {
  const color=String(value||"");
  return (["green","red","yellow","pink","purple"] as const).includes(color as "green"|"red"|"yellow"|"pink"|"purple") ? color as TicketRow["rowColor"] : value ? "green" : undefined;
};
type TicketShiftDraft = { rows: TicketRow[]; allowances: Record<number,string>; kinhTrung: string; extraRoles?: { organ: string; ticketChecker: string }; caseMode: "regular" | "weekend" | "holiday" | "tet" | "half" | "support100" | "support200"; clientId?: string };
type ReportCode = { slot: number; ticket_inventory_id: number; actual_remaining: number | null; defective_quantity: number; cancellation_status: string; ticket_inventory: { code: string } | null };
type ReportRound = { id: number; client_id?: string; sequence_no: number; opening_quantity: number; sold_quantity: number; ticket_price: number; gift_value: number; status: string; reconciliation_confirmed_at?: string | null; reconciliation_confirmed_by?: string | null; reconciliation_variance?: number | null; ticket_round_codes: ReportCode[] };
function ticketRoundReconciliation(round: Pick<ReportRound,"status"|"opening_quantity"|"sold_quantity"|"reconciliation_confirmed_at"|"reconciliation_variance"|"ticket_round_codes">) {
  const approvedCodes=round.ticket_round_codes.filter(code=>code.cancellation_status==="approved");
  const activeCodes=round.ticket_round_codes.filter(code=>code.cancellation_status!=="approved");
  const approvedBalance=approvedCodes.reduce((sum,code)=>sum+Number(code.actual_remaining||0)+Number(code.defective_quantity||0),0);
  const expected=Number(round.opening_quantity||0)-Number(round.sold_quantity||0)-approvedBalance;
  const reported=activeCodes.reduce((sum,code)=>sum+Number(code.actual_remaining||0)+Number(code.defective_quantity||0),0);
  const defectiveTickets=round.ticket_round_codes.reduce((sum,code)=>sum+Number(code.defective_quantity||0),0);
  const hasSale=Number(round.sold_quantity||0)>0;
  const hasCompleteEntry=hasSale&&round.ticket_round_codes.length>0&&round.ticket_round_codes.every(code=>code.actual_remaining!==null);
  const hasValidReport=round.status==="verified"&&hasCompleteEntry;
  const variance=expected-reported;
  const isVarianceConfirmed=Boolean(round.reconciliation_confirmed_at)&&Number(round.reconciliation_variance)===variance;
  const hasOutstandingVariance=hasValidReport&&(variance!==0||defectiveTickets>0)&&!isVarianceConfirmed;
  return {activeCodes,approvedCodes,expected,reported,defectiveTickets,hasSale,hasCompleteEntry,hasValidReport,variance,isVarianceConfirmed,hasOutstandingVariance};
}
type PendingReportShift = Shift & { round_count:number; verified_count:number; report_started:boolean };
type FinanceEntry = { id: number; entry_date: string; entry_type: "revenue" | "expense"; category: string; amount: number; note: string | null; status: string; created_at: string; venue_id: number };
type RevenueSnapshot = { total:number; categories:Record<string,number> };
type OverviewRevenueStats = { date:string; yesterdayDate:string; previousWeekDate:string; weekStart:string; weekEnd:string; monthStart:string; current:RevenueSnapshot; currentWeek:RevenueSnapshot; currentMonth:RevenueSnapshot; yesterday:RevenueSnapshot; previousWeek:RevenueSnapshot };
type OverviewVenueRevenue = { venue_id:number; day_total:number; week_total:number; day_expense:number; week_expense:number };
type OverviewTicketVariance = { venue_id:number; total_rounds:number; reported_rounds:number; mismatch_rounds:number; surplus_rounds:number; shortage_rounds:number; surplus_tickets:number; shortage_tickets:number; defective_rounds:number; defective_tickets:number };
type OverviewTicketStaleCode = { code:string; quantity:number; last_used_date:string|null; days_unused:number };
type OverviewTicketStock = { venue_id:number; available_codes:number; source_configured:boolean; stale_codes:OverviewTicketStaleCode[] };
type BonusWeek = { week_start:string; week_end:string; weekly_revenue:number; target_amount:number; achieved:boolean; proposed_bonus:number; settlement_id:number|null; settlement_date:string|null; paid_at:string|null };
type GoAnLacNightReward = { employee_id:number; performance_date:string; revenue_amount:number; reward_amount:number };
type GameQuantityKey = "ticket_10k_quantity" | "ticket_20k_quantity" | "inflatable_20k_quantity" | "nlh_30k_quantity";
type GameReport = { id:number; shift_id:number; report_date:string; total_amount:number } & Record<GameQuantityKey,number>;
type GameInventoryRow = { id:number; product_key:"ticket_10k"|"ticket_20k"|"inflatable_20k"|"nlh_30k"; quantity_on_hand:number; updated_at:string };
type TicketApproval = { round_id: number; slot: number; actual_remaining: number | null; cancellation_status: string; ticket_inventory: { code: string } | null; round: { sequence_no: number; shift: { venue_id: number; performance_date: string } | null } | null };
type KioskBill = { id:number; kiosk_id:number; billing_month:string; rent_amount:number; base_rent_amount:number; rent_escalation_rate:number; rent_escalation_amount:number; electric_old:number; electric_new:number; electric_amount:number; water_old:number; water_new:number; water_amount:number; service_fee:number; garbage_fee:number; security_fee:number; surcharge:number; previous_debt:number; total_due:number; closing_date:string; due_date:string; payment_status:"unpaid"|"paid"|"cancelled"; paid_date:string|null; paid_amount:number|null; note:string|null; kiosk:{ kiosk_code:string; kiosk_name:string; default_rent:number; lease_start:string|null; lease_end:string|null; deposit_amount:number; rent_period_start:string|null; rent_period_end:string|null; escalation_rate:number; escalation_start:string|null; escalation_end:string|null } | null };
type KioskApprovalHistory = { id:number; venue_id:number; bill_id:number; paid_date:string; amount:number; created_by:string|null; created_at:string; bill:{ billing_month:string; kiosk:{ kiosk_code:string; kiosk_name:string } | null } | null };
type KioskConfig = { id:number; business_id:number; venue_id:number; kiosk_code:string; kiosk_name:string; default_rent:number; default_service_fee:number; default_garbage_fee:number; default_security_fee:number; is_active:boolean };
type KioskDraft = { rent:string; electricOld:string; electricNew:string; waterOld:string; waterNew:string; serviceFee:string; garbageFee:string; securityFee:string; surcharge:string; previousDebt:string; note:string; closingDate:string; dueDate:string; leaseStart:string; leaseEnd:string; deposit:string; rentPeriodStart:string; rentPeriodEnd:string; escalationRate:string; escalationStart:string; escalationEnd:string };
type InventoryEntryRow = { id:string; code:string; handover:string };
type InventoryStockRow = { id:number; code:string; handover_quantity:number; status:string; updated_at?:string|null };
type UserAccount = { user_id:string; username:string|null; full_name:string; role:string; status:string; access_level:number; venue_id:number|null; employee_id:number|null };
type MonthlyScore = { employee_id:number; base_points:number; bonus_points:number; costume_deduction:number; support_singing_deduction:number; number_error_deduction:number; late_rehearsal_deduction:number; slang_deduction:number; weekend_off_deduction:number; holiday_off_deduction:number; tet_off_deduction:number; sudden_off_deduction:number; other_deduction:number; remaining_points:number; note:string|null };
type CompetitionViolation = { id:number; employee_id:number; violation_date:string; violation_type:"costume_deduction"|"support_singing_deduction"|"number_error_deduction"|"late_rehearsal_deduction"|"slang_deduction"|"other_deduction"; occurrence_count:number; points:number; note:string|null; created_at:string };
type AnnualScore = { employee_id:number; total_remaining_points:number; payout_amount:number; special_bonus?:number };
type CostumeScore = { employee_id:number; ao_dai_count:number; dress_count:number; ba_ba_count:number; investment_amount:number; submitted_on_time:boolean; photographed_at_venue:boolean; total_outfits:number; passed:boolean; monthly_reward:number; rank_position:number|null; ranking_qualified:boolean; rank_bonus:number; total_reward:number; note:string|null };
type AnnualCostumeScore = CostumeScore & { score_month:string };
type CostumeSubmission = { id:number; employee_id:number; venue_id?:number|null; submission_date:string; costume_type:"ao_dai"|"dress"|"ba_ba"; quantity:number; note:string|null; photo_path:string|null; created_at:string; signed_url?:string|null };
type CostumePlanReference = { id:number; plan_month:string; image_path:string; created_at:string; signed_url?:string };
type CostumePlanDay = { date:string; dao:string; kep:string; special:boolean; note:string };
type PublicHighlights = {
  costume_winners: Array<{ name:string; rank:number; outfits:number; reward:number }>;
  top_scores: Array<{ name:string; points:number; rank:number }>;
  gallery: Array<{ image_url:string; caption:string|null }>;
};
type PublicAlbumItem = { id:number; image_path:string; caption:string|null; is_published:boolean; published_at:string|null; created_at:string };
type AttendanceSession = { id:number; venue_id:number; employee_id:number; work_date:string; checked_in_at:string; checked_out_at:string|null; last_heartbeat_at:string; status:"active"|"closed"; auto_closed:boolean; check_out_reason:string|null };
type LotoAreaAttendance = { id:number;venue_id:number;work_date:string;check_in_at:string|null;check_out_at:string|null;check_in_photo_urls?:string[];check_out_photo_urls?:string[];is_late:boolean;late_reason:string|null;approval_status:string;monthly_violation_no:number;reminder_sent:boolean;penalty_amount:number;venue?:{name:string}|null;manager?:{full_name:string}|null };
type TimeOffRequest = { id:number;employee_id:number;off_date:string;week_start:string;status:"pending"|"approved"|"rejected";note?:string|null;created_at?:string;employee?:{full_name:string}|null };
type WeeklyStaffSchedule = { id:number;venue_id:number;employee_id:number;work_date:string;week_start:string;venue?:{name:string}|null };
type SalaryAdvance = { id:number;employee_id:number;venue_id:number;request_month:string;request_type:"salary"|"bonus";installment:1|2;amount:number;note:string|null;status:string;created_at:string;employee?:{full_name:string}|null };
type FixedExpenseObligation = { id:number;venue_id:number;employee_id:number|null;expense_month:string;due_date:string;category:string;title:string;amount_due:number;created_at:string;employee?:{full_name:string}|null };
type WorkforceStats = { active:number;joinedThisMonth:number;leftThisMonth:number };

const REJECTION_REASON_MARKER="[LÝ DO TỪ CHỐI]";
const rejectionReasonFromNote=(note?:string|null)=>{
  const value=String(note||"");
  const markerIndex=value.lastIndexOf(REJECTION_REASON_MARKER);
  return markerIndex>=0?value.slice(markerIndex+REJECTION_REASON_MARKER.length).trim():"";
};
const noteWithRejectionReason=(note:string|null|undefined,reason:string)=>{
  const clean=String(note||"").split(REJECTION_REASON_MARKER)[0].trim();
  return `${clean}${clean?"\n":""}${REJECTION_REASON_MARKER} ${reason.trim()}`;
};

const blankTicketRow = (): TicketRow => ({ id: crypto.randomUUID(), codes: ["", "", "", ""], quantities: {}, price: 10000, gift: "" });
const ticketRowHasCode = (row: TicketRow) => row.codes.some((code) => code.trim() !== "");
const DEFAULT_GIFT_OPTIONS=[200000,300000,400000,500000,600000,700000,800000,900000,1000000,1200000,1300000,1400000,1500000,1600000,1700000,1800000,1900000,2000000,2200000,2400000,2500000,2600000,3000000,3500000,4000000,4500000,5000000,5500000,6000000,6500000,7000000,7500000,8000000,8500000,9000000,9500000,10000000];
const promotionMetaFromClientId = (clientId:string) => {
  const match=/^promo-(sale|gift):(.+)$/.exec(clientId||"");
  return match ? { promotionRole:match[1] as "sale"|"gift", promotionGroupId:match[2] } : {};
};
const localDateValue = () => {
  const value = new Date();
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 10);
};
const inputDate = (value:Date) => { const date=new Date(value); date.setMinutes(date.getMinutes()-date.getTimezoneOffset()); return date.toISOString().slice(0,10); };
const dateByDays = (value:string, days:number) => { const date=new Date(`${value}T12:00:00`); date.setDate(date.getDate()+days); return inputDate(date); };
const lotoBonusCycleForDate = (value:string) => {
  const viewedDate=/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(`${value}T12:00:00`):new Date();
  const firstMonday=(year:number,monthIndex:number)=>{
    const date=new Date(year,monthIndex,1,12);
    date.setDate(1+((8-date.getDay())%7));
    return date;
  };
  let cycleYear=viewedDate.getFullYear();
  let cycleMonthIndex=viewedDate.getMonth();
  const currentMonthFirstMonday=firstMonday(cycleYear,cycleMonthIndex);
  if(viewedDate<currentMonthFirstMonday){
    cycleMonthIndex-=1;
    if(cycleMonthIndex<0){cycleMonthIndex=11;cycleYear-=1;}
  }
  const start=firstMonday(cycleYear,cycleMonthIndex);
  const nextMonthFirstMonday=firstMonday(cycleMonthIndex===11?cycleYear+1:cycleYear,(cycleMonthIndex+1)%12);
  const end=new Date(nextMonthFirstMonday);end.setDate(end.getDate()-1);
  return {month:`${cycleYear}-${String(cycleMonthIndex+1).padStart(2,"0")}`,start:inputDate(start),end:inputDate(end)};
};
const nextWeekDays = () => {
  const today=new Date(); today.setHours(12,0,0,0);
  const daysUntilMonday=((8-today.getDay())%7)||7;
  const monday=new Date(today); monday.setDate(today.getDate()+daysUntilMonday);
  const labels=["Thứ Hai","Thứ Ba","Thứ Tư","Thứ Năm","Thứ Sáu","Thứ Bảy","Chủ Nhật"];
  return labels.map((label,index)=>{const date=new Date(monday);date.setDate(monday.getDate()+index);return{label,date:inputDate(date)};});
};
const weekDaysFromStart = (weekStart:string) => {
  const labels=["Thứ Hai","Thứ Ba","Thứ Tư","Thứ Năm","Thứ Sáu","Thứ Bảy","Chủ Nhật"];
  return labels.map((label,index)=>({label,date:dateByDays(weekStart,index)}));
};
const currentWeekDays = () => {
  const today=new Date(); today.setHours(12,0,0,0);
  const monday=new Date(today); monday.setDate(today.getDate()-((today.getDay()+6)%7));
  const labels=["Thứ Hai","Thứ Ba","Thứ Tư","Thứ Năm","Thứ Sáu","Thứ Bảy","Chủ Nhật"];
  return labels.map((label,index)=>{const date=new Date(monday);date.setDate(monday.getDate()+index);return{label,date:inputDate(date)};});
};
const timeOffRegistrationWindow=()=>{
  const now=new Date();
  const day=now.getDay();
  const minutes=now.getHours()*60+now.getMinutes();
  const open=(day===6&&minutes>=1)||(day===0&&minutes<=12*60);
  return {open,label:open?"Đang Mở Đăng Ký":"Đã Khóa Đăng Ký",detail:open?"Mở đến 12:00 Chủ Nhật":"Mở lại lúc 00:01 Thứ Bảy"};
};
const TIME_OFF_EMERGENCY_NOTE="[OFF_DOT_XUAT]";
const isVietnamTetHoliday=(value:string)=>{
  const date=new Date(`${value}T12:00:00`);
  try {
    const parts=new Intl.DateTimeFormat("en-u-ca-chinese",{month:"numeric",day:"numeric"}).formatToParts(date);
    const lunarMonth=Number(parts.find(part=>part.type==="month")?.value||0);
    const lunarDay=Number(parts.find(part=>part.type==="day")?.value||0);
    return lunarMonth===1&&lunarDay>=1&&lunarDay<=5;
  } catch { return false; }
};

const REVENUE_REPORTING_START = "2026-08-10";
async function costumePhotoSignatures(file:File){
  const digest=await crypto.subtle.digest("SHA-256",await file.arrayBuffer());
  const photoHash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
  const bitmap=await createImageBitmap(file);
  const canvas=document.createElement("canvas");canvas.width=9;canvas.height=8;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  if(!context){bitmap.close();return{photoHash,photoFingerprint:null};}
  context.drawImage(bitmap,0,0,9,8);bitmap.close();
  const pixels=context.getImageData(0,0,9,8).data;
  let bits="";
  const gray=(index:number)=>pixels[index]*0.299+pixels[index+1]*0.587+pixels[index+2]*0.114;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){const left=(y*9+x)*4,right=(y*9+x+1)*4;bits+=gray(left)>gray(right)?"1":"0";}
  let photoFingerprint="";for(let index=0;index<64;index+=4)photoFingerprint+=parseInt(bits.slice(index,index+4),2).toString(16);
  return{photoHash,photoFingerprint};
}
const isVietnamPublicHoliday=(value:string)=>{
  const date=new Date(`${value}T12:00:00`);
  const month=date.getMonth()+1,day=date.getDate();
  if(["1-1","4-30","5-1","9-2"].includes(`${month}-${day}`))return true;
  try {
    const parts=new Intl.DateTimeFormat("en-u-ca-chinese",{month:"numeric",day:"numeric"}).formatToParts(date);
    const lunarMonth=Number(parts.find(part=>part.type==="month")?.value||0);
    const lunarDay=Number(parts.find(part=>part.type==="day")?.value||0);
    return (lunarMonth===1&&lunarDay>=1&&lunarDay<=5)||(lunarMonth===3&&lunarDay===10);
  } catch { return false; }
};
const nextCostumePlanMonth=()=>{
  const today=new Date();
  return `${today.getFullYear()+(today.getMonth()===11?1:0)}-${String((today.getMonth()+1)%12+1).padStart(2,"0")}`;
};
const generateCostumePlan=(month:string):CostumePlanDay[]=>{
  const [year,monthNumber]=month.split("-").map(Number);
  const days=new Date(year,monthNumber,0).getDate();
  const daoStyles=["Đầm ngắn thanh lịch","Đầm dài cổ điển","Đầm công chúa","Đầm hoa","Đầm chữ A","Đầm xếp ly","Đầm dạ hội","Đầm suông"];
  const daoColours=["trắng","xanh ngọc","đỏ đô","tím","vàng kem","xanh coban","hồng phấn","cam đất"];
  const kepStyles=["Sơ mi","Sơ mi + ghi lê","Vest","Sơ mi cổ trụ","Sơ mi họa tiết","Sơ mi chữ Y"];
  const kepColours=["trắng","xanh coban","đỏ đô","kem","xám bạc","xanh rêu"];
  const weekendColours=["đỏ đô","xanh ngọc","vàng kim","tím than","hồng phấn","xanh coban"];
  return Array.from({length:days},(_,index)=>{
    const date=`${month}-${String(index+1).padStart(2,"0")}`;
    const value=new Date(`${date}T12:00:00`);
    const weekday=value.getDay();
    let dao=`${daoStyles[index%daoStyles.length]} ${daoColours[Math.floor(index/daoStyles.length)%daoColours.length]}`;
    let kep=`${kepStyles[index%kepStyles.length]} ${kepColours[Math.floor(index/kepStyles.length)%kepColours.length]}`;
    let note="";
    let special=false;
    if(isVietnamPublicHoliday(date)){
      special=true;
      if(value.getMonth()===8&&value.getDate()===2){dao="Áo dài đỏ bộ";kep="Áo dài đỏ bộ";note="Quốc khánh Việt Nam";}
      else {const colour=weekendColours[index%weekendColours.length];dao=`Áo dài lễ ${colour}`;kep=`Bà ba lễ ${colour}`;note="Ngày lễ Việt Nam";}
    } else if(weekday===6){const colour=weekendColours[Math.floor(index/7)%weekendColours.length];special=true;dao=`Áo dài ${colour} trọn bộ`;kep=`Áo dài ${colour} trọn bộ`;note="Cuối tuần";}
    else if(weekday===0){const colour=weekendColours[(Math.floor(index/7)+2)%weekendColours.length];special=true;dao=`Bà ba ${colour} trọn bộ`;kep=`Bà ba ${colour} trọn bộ`;note="Cuối tuần";}
    return {date,dao,kep,special,note};
  });
};
const timeOffNeedsApproval=(offDate:string,note?:string|null)=>{
  const weekday=new Date(`${offDate}T12:00:00`).getDay();
  return weekday===0||weekday===6||isVietnamPublicHoliday(offDate)||Boolean(note?.includes(TIME_OFF_EMERGENCY_NOTE));
};
const financeDateRange = (anchor:string,period:"day"|"week"|"month") => {
  const date=new Date(anchor+"T00:00:00");
  if (period==="day") return {start:anchor,end:anchor};
  if (period==="week") { const offset=(date.getDay()+6)%7; const start=new Date(date); start.setDate(date.getDate()-offset); const end=new Date(start); end.setDate(start.getDate()+6); return {start:inputDate(start),end:inputDate(end)}; }
  return {start:inputDate(new Date(date.getFullYear(),date.getMonth(),1)),end:inputDate(new Date(date.getFullYear(),date.getMonth()+1,0))};
};
const firstSunday = (year:number,month:number) => { const date=new Date(year,month,1); date.setDate(1+((7-date.getDay())%7)); return date; };
const recentWorkDates = () => Array.from({length:31},(_,offset) => {
  const date=new Date();
  date.setHours(12,0,0,0);
  date.setDate(date.getDate()-offset);
  return inputDate(date);
});
const revenueHistoryDates = () => Array.from({length:366},(_,offset) => {
  const date=new Date();
  date.setHours(12,0,0,0);
  date.setDate(date.getDate()-offset);
  return inputDate(date);
});
const gameProducts: Array<{key:GameQuantityKey;label:string;price:number}> = [
  {key:"ticket_10k_quantity",label:"Vé 10K",price:10000},
  {key:"ticket_20k_quantity",label:"Vé 20K",price:20000},
  {key:"inflatable_20k_quantity",label:"Nhà Hơi 20K",price:20000},
  {key:"nlh_30k_quantity",label:"NLH 30K",price:30000},
];
const gameProductPrice = (product:{key:GameQuantityKey;price:number},venueId:number|string|undefined|null) =>
  product.key==="nlh_30k_quantity" && Number(venueId)===3 ? 40000 : product.price;
const competitionViolationTicks = [["costume_deduction","Trang Phục",2],["support_singing_deduction","Hát Lót",2],["number_error_deduction","Lộn Số",2],["late_rehearsal_deduction","Đi Trễ / Tập Chương Trình",3],["slang_deduction","Tiếng Lóng",2]] as const;
const competitionDeductions = [["costume_deduction","Trang Phục −2"],["support_singing_deduction","Hát Lót −2"],["number_error_deduction","Lộn Số −2"],["late_rehearsal_deduction","Đi Trễ / Tập Chương −3"],["slang_deduction","Tiếng Lóng −2"],["weekend_off_deduction","Off T7/CN −5 · Liên Tiếp −15"],["holiday_off_deduction","Off Lễ −10"],["sudden_off_deduction","Off Đột Xuất −5"],["other_deduction","Khác"]] as const;

function automaticOffDeductions(requests:TimeOffRequest[],employeeId:number,month:string){
  const rows=requests.filter(row=>row.employee_id===employeeId&&row.off_date.startsWith(month)&&row.status!=="rejected");
  let holiday=0,sudden=0,weekend=0;
  const weekendWeeks=new Map<string,Set<number>>();
  rows.forEach(row=>{
    if(isVietnamTetHoliday(row.off_date))return;
    if(isVietnamPublicHoliday(row.off_date)){holiday+=10;return;}
    const weekday=new Date(`${row.off_date}T12:00:00`).getDay();
    if(weekday===0||weekday===6){
      const days=weekendWeeks.get(row.week_start)||new Set<number>();days.add(weekday);weekendWeeks.set(row.week_start,days);return;
    }
    if(row.note?.includes(TIME_OFF_EMERGENCY_NOTE))sudden+=5;
  });
  weekendWeeks.forEach(days=>{weekend+=days.has(0)&&days.has(6)?15:5;});
  return {weekend_off_deduction:weekend,holiday_off_deduction:holiday,sudden_off_deduction:sudden,tet_off_deduction:0};
}

function competitionRemainingPoints(row:MonthlyScore){
  const deductions=row.costume_deduction+row.support_singing_deduction+row.number_error_deduction+row.late_rehearsal_deduction+row.slang_deduction+row.weekend_off_deduction+row.holiday_off_deduction+row.sudden_off_deduction+row.other_deduction;
  return Math.max(0,row.base_points+row.bonus_points-deductions);
}

function isTransientNotice(value:string){
  return /^(Đã|Cập nhật|Lưu)\b/i.test(value.trim());
}

const menus = [
  ["Loto", ["File Vé", "Lịch Sử File Vé", "Check In / Check Out Khu", "Nhập Kho Vé", "Doanh Thu Loto", "Báo Cáo Vé"]],
  ["Trò Chơi", ["Doanh Thu Trò Chơi", "Nhập Kho Vé Trò Chơi"]],
  ["Quán Nước", ["Doanh Thu Quán Nước", "Báo Cáo Nước"]],
  ["Nhân Sự Tư Hậu", ["Danh Sách Nhân Sự", "Chấm Công", "Lịch Của Tôi", "Lịch Nhân Sự", "Lịch Trang Phục", "Đăng Ký Off", "Thi Đua", "Lương Và Thu Nhập", "Trạng Thái Đề Xuất"]],
  ["Kios", ["Thu Tiền Kios", "Chi Phí Kios"]],
] as const;

export default function Home() {
  const supabase = supabaseClient;
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const remoteReloadTimerRef=useRef<number|null>(null);
  useEffect(() => {
    if (!message.trim()) return;
    const timeout = window.setTimeout(() => setMessage(current => current === message ? "" : current), 5000);
    return () => window.clearTimeout(timeout);
  }, [message]);
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [userAccounts, setUserAccounts] = useState<UserAccount[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserLevel, setNewUserLevel] = useState("3");
  const [newUserVenue, setNewUserVenue] = useState("");
  const [newUserEmployee,setNewUserEmployee]=useState("");
  const [userSaving, setUserSaving] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [managerVenueChosen, setManagerVenueChosen] = useState(true);
  const [managerVenueLoading, setManagerVenueLoading] = useState(false);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const activeShiftRef=useRef<Shift|null>(null);
  const approvalsLoadInFlightRef=useRef(false);
  const ticketFixedControlRef=useRef<HTMLDivElement|null>(null);
  const [openVenueShifts, setOpenVenueShifts] = useState<Shift[]>([]);
  const [shiftOperatorNames,setShiftOperatorNames]=useState<Record<string,string>>({});
  const [shiftStaffCounts,setShiftStaffCounts]=useState<Record<number,number>>({});
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [selectedStaff, setSelectedStaff] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [venueId, setVenueId] = useState("");
  const [shiftName, setShiftName] = useState(`Ca tối ${new Intl.DateTimeFormat("vi-VN").format(new Date())}`);
  const [shiftWorkDate, setShiftWorkDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState<"publicHome" | "overview" | "module" | "ticketSetup" | "ticketHistory" | "tickets" | "ticketReport" | "ticketInventoryEntry" | "gameReport" | "gameInventory" | "finance" | "expenseCenter" | "kioskRevenue" | "staffManagement" | "lotoAttendance" | "approvals" | "users" | "publicGallery">("overview");
  const routeReadyRef=useRef(false);
  const restoringRouteRef=useRef(false);
  const visiblePanelRef=useRef(panel);
  const [moduleSection, setModuleSection] = useState("Tổng Quan");
  const [personnelTab, setPersonnelTab] = useState<"directory"|"mySchedule"|"schedule"|"costume"|"off"|"competition"|"attendance"|"advance"|"payroll"|"requests">("directory");
  const [scoreMonth,setScoreMonth]=useState(localDateValue().slice(0,7));
  const [monthlyScores,setMonthlyScores]=useState<Record<number,MonthlyScore>>({});
  const [annualScores,setAnnualScores]=useState<Record<number,AnnualScore>>({});
  const [costumeScores,setCostumeScores]=useState<Record<number,CostumeScore>>({});
  const [annualCostumeScores,setAnnualCostumeScores]=useState<AnnualCostumeScore[]>([]);
  const [competitionView,setCompetitionView]=useState<"costume"|"annual">("costume");
  const [costumeSubmissions,setCostumeSubmissions]=useState<CostumeSubmission[]>([]);
  const [directoryEmployeeId,setDirectoryEmployeeId]=useState<number|null>(null);
  const [directoryEmployeeView,setDirectoryEmployeeView]=useState<"costume"|"evaluation"|null>(null);
  const [costumeUploadType,setCostumeUploadType]=useState<"ao_dai"|"dress"|"ba_ba">("ao_dai");
  const [costumeUploadFile,setCostumeUploadFile]=useState<File|null>(null);
  const [costumeUploading,setCostumeUploading]=useState(false);
  const [ownerCostumeEmployeeId,setOwnerCostumeEmployeeId]=useState("");
  const [ownerCostumeVenueId,setOwnerCostumeVenueId]=useState("");
  const [ownerCostumeType,setOwnerCostumeType]=useState<"ao_dai"|"dress"|"ba_ba">("ao_dai");
  const [ownerCostumeFile,setOwnerCostumeFile]=useState<File|null>(null);
  const [ownerCostumeUploading,setOwnerCostumeUploading]=useState(false);
  const [costumePlanMonth,setCostumePlanMonth]=useState(nextCostumePlanMonth);
  const [costumePlan,setCostumePlan]=useState<CostumePlanDay[]>([]);
  const [costumeReferenceFiles,setCostumeReferenceFiles]=useState<File[]>([]);
  const [costumeReferences,setCostumeReferences]=useState<CostumePlanReference[]>([]);
  const [costumeReferenceUploading,setCostumeReferenceUploading]=useState(false);
  const [publicHighlights,setPublicHighlights]=useState<PublicHighlights>({costume_winners:[],top_scores:[],gallery:[]});
  const [publicLoading,setPublicLoading]=useState(true);
  const [publicAlbumItems,setPublicAlbumItems]=useState<PublicAlbumItem[]>([]);
  const [albumFiles,setAlbumFiles]=useState<File[]>([]);
  const [albumCaption,setAlbumCaption]=useState("");
  const [albumUploading,setAlbumUploading]=useState(false);
  const [albumLightbox,setAlbumLightbox]=useState<{url:string;caption:string}|null>(null);
  const [shiftStaff, setShiftStaff] = useState<ShiftPerson[]>([]);
  const [editingShiftStaff, setEditingShiftStaff] = useState(false);
  const [ticketInventory, setTicketInventory] = useState<TicketItem[]>([]);
  const [ticketInventoryCatalog, setTicketInventoryCatalog] = useState<TicketItem[]>([]);
  const [giftOptions, setGiftOptions] = useState<number[]>([]);
  const [ticketRows, setTicketRows] = useState<TicketRow[]>(() => Array.from({ length: 12 }, blankTicketRow));
  const [rowsToAdd, setRowsToAdd] = useState("5");
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketDraftStatus,setTicketDraftStatus]=useState<"idle"|"saving"|"saved"|"offline"|"error">("idle");
  const [isOnline,setIsOnline]=useState(true);
  const [ticketDraftSavedAt,setTicketDraftSavedAt]=useState<string>("");
  const ticketDraftReadyShiftRef=useRef<number|null>(null);
  const ticketDraftRevisionRef=useRef(0);
  const ticketDraftInFlightRef=useRef(false);
  const ticketRowsSaveInFlightRef=useRef(false);
  const ticketDraftQueuedRef=useRef(false);
  const ticketDraftLatestRef=useRef<{
    shiftId:number;
    businessId:number;
    venueId:number;
    payload:TicketShiftDraft;
    updatedBy:string;
    revision:number;
  }|null>(null);
  const ticketSkipDraftPersistRef=useRef(false);
  const ticketLocalEditUntilRef=useRef(0);
  const ticketPendingRemoteDraftRef=useRef<any>(null);
  const ticketLocalDirtyRef=useRef(false);
  const ticketLastServerDraftAtRef=useRef("");
  const ticketDraftClientIdRef=useRef("");
  const ticketDraftClientId=()=>{
    if(ticketDraftClientIdRef.current)return ticketDraftClientIdRef.current;
    const storageKey="ticket-draft-client-id";
    let value="";
    try{value=sessionStorage.getItem(storageKey)||"";}catch{}
    if(!value){value=crypto.randomUUID();try{sessionStorage.setItem(storageKey,value);}catch{}}
    ticketDraftClientIdRef.current=value;
    return value;
  };
  const [ticketZoom, setTicketZoom] = useState("0.9");
  const [ticketViewportWidth,setTicketViewportWidth]=useState(0);
  const [visibleTicketCodeColumns,setVisibleTicketCodeColumns]=useState(1);
  const usedTicketCodeColumns=Math.min(3,Math.max(1,...ticketRows.map(row=>row.codes.slice(0,3).reduce((last,code,index)=>String(code||"").trim()?index+1:last,0))));
  const ticketCodeColumnCount=Math.max(visibleTicketCodeColumns,usedTicketCodeColumns);
  const ticketTableBaseWidth=82+(ticketCodeColumnCount*92)+(ticketCodeColumnCount<3?70:0)+(shiftStaff.length*112)+(5*86);
  const ticketAutoFitZoom=ticketViewportWidth>0?Math.min(Number(ticketZoom),Math.max(.1,(ticketViewportWidth-8)/ticketTableBaseWidth)):Number(ticketZoom);
  const ticketTableFitStyle={width:`${ticketTableBaseWidth}px`,minWidth:`${ticketTableBaseWidth}px`,zoom:ticketAutoFitZoom} as React.CSSProperties;
  const [caseMode, setCaseMode] = useState<"regular" | "weekend" | "holiday" | "tet" | "half" | "support100" | "support200">("regular");
  const [allowances, setAllowances] = useState<Record<number, string>>({});
  const [kinhTrung, setKinhTrung] = useState("");
  const [ticketExtraRoles,setTicketExtraRoles]=useState({organ:"",ticketChecker:""});
  const [reportVenueId,setReportVenueId]=useState("");
  const [reportShiftId,setReportShiftId]=useState("");
  const [reportVarianceOnly,setReportVarianceOnly]=useState(false);
  const [reportHistoryMode,setReportHistoryMode]=useState(false);
  const [reportHistoryDate,setReportHistoryDate]=useState(localDateValue());
  const [pendingReportShifts,setPendingReportShifts]=useState<PendingReportShift[]>([]);
  const [reportRounds, setReportRounds] = useState<ReportRound[]>([]);
  const [reportLoading, setReportLoading] = useState(false);
  const reportRoundsRef=useRef<ReportRound[]>([]);
  const reportSaveTimersRef=useRef<Map<number,number>>(new Map());
  const reportSaveChainsRef=useRef<Map<number,Promise<boolean>>>(new Map());
  const reportDraftRevisionRef=useRef(0);
  const reportLocalDirtyRef=useRef(false);
  const reportRemoteRefreshPendingRef=useRef(false);
  useEffect(()=>{reportRoundsRef.current=reportRounds;},[reportRounds]);
  const [confirmingVarianceRoundId,setConfirmingVarianceRoundId]=useState<number|null>(null);
  const [expandedDefectiveCodes,setExpandedDefectiveCodes]=useState<Record<string,boolean>>({});
  const [financeMode, setFinanceMode] = useState<"revenue" | "expense">("revenue");
  const [financePeriod, setFinancePeriod] = useState<"day"|"week"|"month">("day");
  const [financeDate, setFinanceDate] = useState("");
  const [financeEntryDate, setFinanceEntryDate] = useState(localDateValue());
  const [financeCategory, setFinanceCategory] = useState("loto");
  const [financeAmount, setFinanceAmount] = useState("");
  const [financeNote, setFinanceNote] = useState("");
  const [expenseCenterVenueId,setExpenseCenterVenueId]=useState("");
  const [expenseCenterCategory,setExpenseCenterCategory]=useState<"stage"|"loto"|"game"|"water"|"other"|"payroll">("stage");
  const [expenseCenterPayrollType,setExpenseCenterPayrollType]=useState<"advance"|"daily"|"weekly"|"monthly"|"other">("advance");
  const [expenseCenterEmployeeId,setExpenseCenterEmployeeId]=useState("");
  const [expenseCenterDate,setExpenseCenterDate]=useState(localDateValue());
  const [expenseCenterAmount,setExpenseCenterAmount]=useState("");
  const [expenseCenterNote,setExpenseCenterNote]=useState("");
  const [expenseCenterSaving,setExpenseCenterSaving]=useState(false);
  const [fixedExpenses,setFixedExpenses]=useState<FixedExpenseObligation[]>([]);
  const [fixedExpensePayments,setFixedExpensePayments]=useState<Record<string,{approved:number;pending:number}>>({});
  const [fixedExpenseForm,setFixedExpenseForm]=useState({dueDate:localDateValue(),venueId:"",employeeId:"",category:"other",title:"",amount:""});
  const [fixedExpensePaymentAmounts,setFixedExpensePaymentAmounts]=useState<Record<number,string>>({});
  const [fixedExpenseLoading,setFixedExpenseLoading]=useState(false);
  const [fixedExpenseMonth,setFixedExpenseMonth]=useState(localDateValue().slice(0,7));
  const [editingFixedExpenseId,setEditingFixedExpenseId]=useState<number|null>(null);
  const [financeEntries, setFinanceEntries] = useState<FinanceEntry[]>([]);
  const [editingFinanceId,setEditingFinanceId]=useState<number|null>(null);
  const [overviewRevenue,setOverviewRevenue]=useState<OverviewRevenueStats|null>(null);
  const [overviewVenueRevenue,setOverviewVenueRevenue]=useState<OverviewVenueRevenue[]>([]);
  const [overviewRevenueLoading,setOverviewRevenueLoading]=useState(false);
  const [overviewTicketVariances,setOverviewTicketVariances]=useState<OverviewTicketVariance[]>([]);
  const [overviewTicketVarianceLoading,setOverviewTicketVarianceLoading]=useState(false);
  const [overviewTicketStocks,setOverviewTicketStocks]=useState<OverviewTicketStock[]>([]);
  const [shiftTicketStockAlert,setShiftTicketStockAlert]=useState<OverviewTicketStock|null>(null);
  const [overviewRevenueSelection,setOverviewRevenueSelection]=useState<string|null>(null);
  const [overviewRevenueDate,setOverviewRevenueDate]=useState(localDateValue());
  const [financeVenueOverride,setFinanceVenueOverride]=useState<number|null>(null);
  const [bonusWeeks, setBonusWeeks] = useState<BonusWeek[]>([]);
  const [bonusResponsibleByVenue,setBonusResponsibleByVenue]=useState<Record<number,string>>({});
  const [goAnLacResponsibleIds,setGoAnLacResponsibleIds]=useState<string[]>(["","",""]);
  const [goAnLacNightRewards,setGoAnLacNightRewards]=useState<GoAnLacNightReward[]>([]);
  const [goAnLacRewardSaving,setGoAnLacRewardSaving]=useState(false);
  const [gameQuantities, setGameQuantities] = useState<Record<GameQuantityKey,string>>({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
  const [gameAmounts, setGameAmounts] = useState<Record<GameQuantityKey,string>>({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
  const [gameReady, setGameReady] = useState(false);
  const [gameTouched, setGameTouched] = useState(false);
  const [gameSaving, setGameSaving] = useState(false);
  const gameSaveLockRef = useRef(false);
  const [gameReportDate, setGameReportDate] = useState("");
  const [gameInventoryVenueId,setGameInventoryVenueId]=useState("");
  const [gameInventoryDrafts,setGameInventoryDrafts]=useState<Record<GameQuantityKey,string>>({ticket_10k_quantity:"0",ticket_20k_quantity:"0",inflatable_20k_quantity:"0",nlh_30k_quantity:"0"});
  const [gameInventoryCounts,setGameInventoryCounts]=useState<Record<GameQuantityKey,string>>({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
  const [gameInventoryRows,setGameInventoryRows]=useState<GameInventoryRow[]>([]);
  const [gameInventoryLoading,setGameInventoryLoading]=useState(false);
  const [gameInventorySaving,setGameInventorySaving]=useState(false);
  const gameInventorySaveLockRef=useRef(false);
  const [pendingExpenses, setPendingExpenses] = useState<FinanceEntry[]>([]);
  const [approvalExpenseHistory,setApprovalExpenseHistory]=useState<FinanceEntry[]>([]);
  const [approvalTimeOffHistory,setApprovalTimeOffHistory]=useState<TimeOffRequest[]>([]);
  const [approvalAdvanceHistory,setApprovalAdvanceHistory]=useState<SalaryAdvance[]>([]);
  const [approvalKioskHistory,setApprovalKioskHistory]=useState<KioskApprovalHistory[]>([]);
  const [approvalHistoryLoading,setApprovalHistoryLoading]=useState(false);
  const [approvalHistoryDate,setApprovalHistoryDate]=useState("");
  const [approvedPayrollPayments,setApprovedPayrollPayments]=useState<Record<number,number>>({});
  const [ticketApprovals, setTicketApprovals] = useState<TicketApproval[]>([]);
  const [financeLoading, setFinanceLoading] = useState(false);
  const [kioskMonth,setKioskMonth]=useState(localDateValue().slice(0,7));
  const [kioskBills,setKioskBills]=useState<KioskBill[]>([]);
  const [kioskApprovalHistory,setKioskApprovalHistory]=useState<KioskApprovalHistory[]>([]);
  const [kioskHistoryLoading,setKioskHistoryLoading]=useState(false);
  const [kioskSaving,setKioskSaving]=useState(false);
  const [kioskDrafts,setKioskDrafts]=useState<Record<number,KioskDraft>>({});
  const [kioskPaymentAmounts,setKioskPaymentAmounts]=useState<Record<number,string>>({});
  const [kioskPaidDate,setKioskPaidDate]=useState(localDateValue());
  const [kioskVenueId,setKioskVenueId]=useState("");
  const [kioskConfigs,setKioskConfigs]=useState<KioskConfig[]>([]);
  const [kioskConfigLoading,setKioskConfigLoading]=useState(false);
  const [kioskConfigSaving,setKioskConfigSaving]=useState(false);
  const [kioskEditingId,setKioskEditingId]=useState<number|null>(null);
  const [kioskConfigDraft,setKioskConfigDraft]=useState({code:"",name:"",rent:"",serviceFee:"",garbageFee:"",securityFee:""});
  const [kioskWorkspaceTab,setKioskWorkspaceTab]=useState<"billing"|"contracts">("billing");
  const [inventoryEntryRows,setInventoryEntryRows]=useState<InventoryEntryRow[]>([{id:crypto.randomUUID(),code:"",handover:""}]);
  const [inventoryEntrySaving,setInventoryEntrySaving]=useState(false);
  const [inventoryVenueId,setInventoryVenueId]=useState("");
  const [inventoryStockRows,setInventoryStockRows]=useState<InventoryStockRow[]>([]);
  const [inventoryStockLoading,setInventoryStockLoading]=useState(false);
  const [inventorySearchDraft,setInventorySearchDraft]=useState("");
  const [inventorySearchTerm,setInventorySearchTerm]=useState("");
  const [inventoryEditingId,setInventoryEditingId]=useState<number|null>(null);
  const [inventoryEditQuantity,setInventoryEditQuantity]=useState("");
  const [inventoryUpdating,setInventoryUpdating]=useState(false);
  const [attendanceVenueId,setAttendanceVenueId]=useState("");
  const [attendanceRadius,setAttendanceRadius]=useState("100");
  const [attendanceSession,setAttendanceSession]=useState<AttendanceSession|null>(null);
  const [attendanceEmployee,setAttendanceEmployee]=useState<Employee|null>(null);
  const [attendanceLoading,setAttendanceLoading]=useState(false);
  const [lotoAttendanceRows,setLotoAttendanceRows]=useState<LotoAreaAttendance[]>([]);
  const [lotoAreaVenueId,setLotoAreaVenueId]=useState("");
  const [lotoAttendanceDate,setLotoAttendanceDate]=useState(localDateValue());
  const [lotoCheckInPhotos,setLotoCheckInPhotos]=useState<File[]>([]);
  const [lotoCheckOutPhotos,setLotoCheckOutPhotos]=useState<File[]>([]);
  const [lotoLateReason,setLotoLateReason]=useState("");
  const [lotoAttendanceLoading,setLotoAttendanceLoading]=useState(false);
  const [timeOffRequests,setTimeOffRequests]=useState<TimeOffRequest[]>([]);
  const [competitionOffRequests,setCompetitionOffRequests]=useState<TimeOffRequest[]>([]);
  const [competitionViolations,setCompetitionViolations]=useState<CompetitionViolation[]>([]);
  const [competitionViolationForm,setCompetitionViolationForm]=useState({employeeId:"",date:localDateValue(),type:"",count:"1",points:"",note:""});
  const [competitionViolationSaving,setCompetitionViolationSaving]=useState(false);
  const [competitionViolationConfirmedEmployeeId,setCompetitionViolationConfirmedEmployeeId]=useState<number|null>(null);
  const [monthlyScoreSavingId,setMonthlyScoreSavingId]=useState<number|null>(null);
  const [monthlyScoreConfirmedIds,setMonthlyScoreConfirmedIds]=useState<Set<number>>(()=>new Set());
  const [responsibilityOffRequests,setResponsibilityOffRequests]=useState<TimeOffRequest[]>([]);
  const [selectedOffDates,setSelectedOffDates]=useState<string[]>([]);
  const [timeOffEmployeeId,setTimeOffEmployeeId]=useState("");
  const [timeOffLoading,setTimeOffLoading]=useState(false);
  const [timeOffApprovals,setTimeOffApprovals]=useState<TimeOffRequest[]>([]);
  const [scheduleVenueId,setScheduleVenueId]=useState("");
  const [scheduleDay,setScheduleDay]=useState("");
  const [scheduleWeekStart,setScheduleWeekStart]=useState(()=>nextWeekDays()[0].date);
  const [scheduleHistoryEditing,setScheduleHistoryEditing]=useState(false);
  const [weeklySchedules,setWeeklySchedules]=useState<WeeklyStaffSchedule[]>([]);
  const [mySchedules,setMySchedules]=useState<WeeklyStaffSchedule[]>([]);
  const [myScheduleEmployeeId,setMyScheduleEmployeeId]=useState("");
  const [scheduleSelections,setScheduleSelections]=useState<Record<string,number>>({});
  const [weeklyScheduleLoading,setWeeklyScheduleLoading]=useState(false);
  const [salaryAdvances,setSalaryAdvances]=useState<SalaryAdvance[]>([]);
  const [salaryAdvanceApprovals,setSalaryAdvanceApprovals]=useState<SalaryAdvance[]>([]);
  const [trackedTimeOffRequests,setTrackedTimeOffRequests]=useState<TimeOffRequest[]>([]);
  const [trackedSalaryAdvances,setTrackedSalaryAdvances]=useState<SalaryAdvance[]>([]);
  const [registrationTrackingLoading,setRegistrationTrackingLoading]=useState(false);
  const [advanceAmount,setAdvanceAmount]=useState("");
  const [advanceInstallment,setAdvanceInstallment]=useState("1");
  const [advanceType,setAdvanceType]=useState<"salary"|"bonus">("salary");
  const [advanceEmployeeId,setAdvanceEmployeeId]=useState("");
  const [hrSaving,setHrSaving]=useState(false);
  const [hrEmployeeId,setHrEmployeeId]=useState("");
  const [addingEmployee,setAddingEmployee]=useState(false);
  const [newEmployeeProfile,setNewEmployeeProfile]=useState({full_name:"",department:"" as Employee["department"]|"",joined_on:localDateValue(),job_title:"",pay_type:"" as Employee["pay_type"]|"",salary:"",weekend_salary:"",holiday_salary:"",weekly_payment_weekday:3,bonus_amount:"",weekday_case:"",weekend_case:"",account_access_level:3,account_venue_id:""});
  const [firstPassword,setFirstPassword]=useState("");
  const [firstPasswordConfirm,setFirstPasswordConfirm]=useState("");
  const [workforceStats,setWorkforceStats]=useState<WorkforceStats>({active:0,joinedThisMonth:0,leftThisMonth:0});
  // Tâm, Thương và Rup Ogran không chấm thi đua trang phục nhưng vẫn phải có
  // trong phần điểm/ thưởng cuối năm để tự xem các khoản thưởng đặc biệt.
  const competitionExcludedNames=new Set(["be 2","huynh duc","my tien","nhan","lam ogran","lam organ","ngoc hoai"]);
  const costumeCompetitionExcludedNames=new Set(["be 2","huynh duc","my tien","nhan","tam ogran","tam organ","thuong ogran","thuong organ"]);
  const canManageAllCompetition=profile?.role==="owner"||Boolean(profile?.allowed_modules?.includes("competition_admin"));
  const competitionEmployees=employees.filter(employee=>{
    const normalizedName=employee.full_name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d").replace(/Đ/g,"d").toLowerCase().trim();
    const withinAccountScope=profile?.role==="employee"?employee.id===profile.employee_id:profile?.role==="manager"&&!canManageAllCompetition?employee.account_venue_id===profile.venue_id:true;
    return withinAccountScope&&employee.department==="loto"&&!competitionExcludedNames.has(normalizedName)&&(competitionView!=="costume"||!costumeCompetitionExcludedNames.has(normalizedName));
  });
  const directoryEmployees=profile?.role==="owner"||profile?.role==="manager"?employees:employees.filter(employee=>employee.id===profile?.employee_id);
  // Phân loại nhân sự theo hồ sơ/bộ phận, không suy luận theo tên.
  // Nhờ đó Tường Vy (Loto) và Chuột (Quán Nước) luôn là hai hồ sơ độc lập.
  const lotoEmployees=employees.filter(employee=>{
    if(employee.department!=="loto")return false;
    if(personnelTab!=="competition"||competitionView!=="costume")return true;
    const normalizedName=employee.full_name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
    return !costumeCompetitionExcludedNames.has(normalizedName);
  });
  const kepLotoNames=new Set(["HUỲNH ĐỨC","THÁI TÂM","THANH TUẤN","BÉ 2","HOÀI NAM","HOÀNG TRỌNG","PHÚC THỊNH","NGỌC HOÀI","NHÂN","TRƯỜNG AN"]);
  const lotoRole=(employee:Employee)=>kepLotoNames.has(employee.full_name.trim().toLocaleUpperCase("vi-VN"))?"kep":"dao";
  const attendanceEmployees=employees.filter(employee=>employee.department!=="loto");
  const isManagement=profile?.role==="owner"||profile?.role==="manager";
  const canManageTicketInventory=profile?.role==="owner";
  const canEditCompetition=isManagement||canManageAllCompetition;
  const isEmployeeOnly=profile?.role==="employee";
  const isLotoScheduleViewer=profile?.role==="employee"&&lotoEmployees.some(employee=>employee.id===profile.employee_id);
  const employeePersonnelTabs=(['directory','mySchedule','schedule','off','competition','requests'] as const);
  const ticketStaffOptions=employees.filter(employee=>employee.department==="loto");
  const canInspectAllSchedules=profile?.role==="owner"||profile?.role==="manager";
  const visibleMenus=profile?.role==="employee"
    ? menus.map(([name,items])=>[name,items.filter(item=>!item.startsWith("Doanh Thu")&&!item.startsWith("Chi")&&item!=="Thu Tiền Kios")] as const)
    : profile?.role==="manager"
      ? menus.map(([name,items])=>[name,items.filter(item=>item!=="Nhập Kho Vé"&&item!=="Xuất Kho Vé"&&item!=="Nhập Kho Vé Trò Chơi")] as const)
      : menus;
  const myScheduleTargetEmployeeId=canInspectAllSchedules?(lotoEmployees.some(employee=>employee.id===Number(myScheduleEmployeeId))?Number(myScheduleEmployeeId):lotoEmployees[0]?.id||null):(profile?.employee_id||null);
  const hrSelectedEmployee=employees.find(employee=>employee.id===(Number(hrEmployeeId)||employees[0]?.id));
  const payrollDepartmentGroups=useMemo(()=>{
    const definitions:[NonNullable<Employee["department"]>|"other",string][]=[
      ["loto","Nhân Sự Loto"],
      ["game","Nhân Sự Trò Chơi"],
      ["water","Nhân Sự Quán Nước"],
      ["kiosk","Nhân Sự Kios"],
      ["office","Nhân Sự Văn Phòng"],
      ["other","Bộ Phận Khác"],
    ];
    return definitions.map(([key,label])=>({
      key,
      label,
      employees:employees.filter(employee=>key==="other"?!employee.department:employee.department===key),
    })).filter(group=>group.employees.length>0);
  },[employees]);
  const selectedVenueName = activeShift
    ? venues.find((venue) => venue.id === activeShift.venue_id)?.name
    : venues.find((venue) => String(venue.id) === venueId)?.name;
  const kioskVenueName = venues.find((venue) => String(venue.id) === kioskVenueId)?.name || "Chưa Chọn Sân Khấu";
  const activeShiftWorkDate = activeShift?.performance_date
    ? new Date(`${activeShift.performance_date}T00:00:00`).toLocaleDateString("vi-VN")
    : "Chưa Chọn";
  const operationalVenueId=financeVenueOverride||activeShift?.venue_id||Number(venueId)||profile?.venue_id||0;
  const linkedExpenseEmployee=employees.find(employee=>employee.id===profile?.employee_id);
  const resolvedExpenseCenterVenueId=profile?.role==="manager"?Number(profile.venue_id||0):profile?.role==="employee"?Number(linkedExpenseEmployee?.account_venue_id||profile.venue_id||0):Number(expenseCenterVenueId||profile?.venue_id||venues[0]?.id||0);
  const expenseResponsibleEmployeeId=Number(bonusResponsibleByVenue[resolvedExpenseCenterVenueId]||0);
  const expenseCenterEmployees=employees.filter(employee=>{
    if(profile?.role==="employee")return employee.id===profile.employee_id;
    const normalizedName=employee.full_name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/Đ/g,"D").replace(/đ/g,"d").toUpperCase().replace(/\s+/g," ").trim();
    const isNamedResponsible=["HUYNH DUC","MINH THU","NGOC HOAI"].includes(normalizedName);
    const matchesDepartment=expenseCenterCategory==="game"?employee.department==="game":expenseCenterCategory==="water"?employee.department==="water":expenseCenterCategory==="loto"||expenseCenterCategory==="payroll"?isNamedResponsible||employee.id===expenseResponsibleEmployeeId:false;
    if(!matchesDepartment)return false;
    return !employee.account_venue_id||employee.account_venue_id===resolvedExpenseCenterVenueId||employee.id===expenseResponsibleEmployeeId;
  });
  const selectedExpenseEmployee=expenseCenterEmployees.find(employee=>employee.id===Number(expenseCenterEmployeeId));
  const expenseCenterSupportsPayroll=["loto","game","water","payroll"].includes(expenseCenterCategory);
  const expenseCenterIsPayroll=expenseCenterSupportsPayroll&&expenseCenterPayrollType!=="other";
  const ticketOwnedByAnother=Boolean(activeShift?.status==="open"&&activeShift.opened_by&&session?.user.id!==activeShift.opened_by);
  const [historyMode,setHistoryMode]=useState(false);
  const [historyVenueId,setHistoryVenueId]=useState("");
  const [historyDate,setHistoryDate]=useState("");
  // Mỗi File Vé chỉ có đúng một tài khoản giữ quyền chỉnh sửa.
  // Owner/manager khác vẫn được vào xem nhưng không được ghi chồng lên phiên đang hoạt động.
  // Người mở ca vẫn là người phụ trách chính. Chủ sở hữu được cộng tác chỉnh sửa
  // trực tiếp trên đúng ca đang mở mà không cần chiếm quyền hoặc đóng ca.
  const canEditTicketShift=Boolean(activeShift?.status==="open"&&(session?.user.id===activeShift.opened_by||profile?.role==="owner"));
  const ticketReadOnly=historyMode||activeShift?.status==="closed"||!canEditTicketShift;
  const ticketManagerView=Boolean(ticketOwnedByAnother&&(profile?.role==="owner"||profile?.role==="manager"));
  const ticketLockOwnerName=activeShift?.opened_by?(shiftOperatorNames[activeShift.opened_by]||"Tài Khoản Đang Làm Việc"):"Tài Khoản Đang Làm Việc";
  const ticketReadOnlyLabel=ticketOwnedByAnother?"ĐANG XEM · TÀI KHOẢN KHÁC ĐANG LÀM VIỆC":"ĐANG XEM LẠI · CHỈ ĐỌC";
  const approvalCount = pendingExpenses.length + timeOffApprovals.length + salaryAdvanceApprovals.length;
  const approvalHistoryItemDate=(item:FinanceEntry|TimeOffRequest|SalaryAdvance|KioskApprovalHistory)=>{
    if("entry_date" in item)return item.entry_date;
    if("off_date" in item)return item.off_date;
    if("paid_date" in item)return item.paid_date;
    return item.created_at?.slice(0,10)||item.request_month;
  };
  const approvalHistoryDates=Array.from(new Set([
    ...approvalExpenseHistory.map(approvalHistoryItemDate),
    ...approvalTimeOffHistory.map(approvalHistoryItemDate),
    ...approvalAdvanceHistory.map(approvalHistoryItemDate),
    ...approvalKioskHistory.map(approvalHistoryItemDate),
  ].filter(Boolean))).sort((a,b)=>b.localeCompare(a));
  const approvalHistoryMatchesDate=(item:FinanceEntry|TimeOffRequest|SalaryAdvance|KioskApprovalHistory)=>!approvalHistoryDate||approvalHistoryItemDate(item)===approvalHistoryDate;
  const filteredApprovalExpenseHistory=approvalExpenseHistory.filter(approvalHistoryMatchesDate);
  const filteredApprovalTimeOffHistory=approvalTimeOffHistory.filter(approvalHistoryMatchesDate);
  const filteredApprovalAdvanceHistory=approvalAdvanceHistory.filter(approvalHistoryMatchesDate);
  const filteredApprovalKioskHistory=approvalKioskHistory.filter(approvalHistoryMatchesDate);
  const ticketApprovalGroups = Object.entries(ticketApprovals.reduce<Record<number,TicketApproval[]>>((groups,item)=>{
    const venueId=Number(item.round?.shift?.venue_id||0);
    if(!groups[venueId])groups[venueId]=[];
    groups[venueId].push(item);
    return groups;
  },{})).map(([venueId,items])=>({venueId:Number(venueId),items})).sort((a,b)=>{
    const aName=venues.find(venue=>venue.id===a.venueId)?.name||"";
    const bName=venues.find(venue=>venue.id===b.venueId)?.name||"";
    return aName.localeCompare(bName,"vi");
  });
  const normalizedFinanceNote=(note:string|null)=>String(note||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/đ/g,"d").trim();
  const confirmedLotoKeys=new Set(financeEntries
    .filter(item=>item.entry_type==="revenue"&&item.category==="loto"&&!normalizedFinanceNote(item.note).startsWith("tu dong"))
    .map(item=>`${item.venue_id}|${item.entry_date}`));
  // Khi đã có số Loto được xác nhận cho đúng sân khấu/ngày, bản tự động cũ chỉ là dữ liệu
  // trung gian và tuyệt đối không được cộng hoặc hiện lại ở bất kỳ bảng tổng hợp nào.
  const effectiveFinanceEntries=financeEntries.filter(item=>!(
    item.entry_type==="revenue"&&
    item.category==="loto"&&
    normalizedFinanceNote(item.note).startsWith("tu dong")&&
    confirmedLotoKeys.has(`${item.venue_id}|${item.entry_date}`)
  ));
  const dailyRevenueTotal = effectiveFinanceEntries.filter(item => item.entry_type === "revenue").reduce((sum,item) => sum + Number(item.amount),0);
  const dailyExpenseTotal = effectiveFinanceEntries.filter(item => item.entry_type === "expense" && item.status === "approved").reduce((sum,item) => sum + Number(item.amount),0);
  const scopedFinanceEntries = financeCategory==="all"?effectiveFinanceEntries:effectiveFinanceEntries.filter(item => item.category === financeCategory);
  const scopedRevenueTotal = scopedFinanceEntries.filter(item => item.entry_type === "revenue").reduce((sum,item) => sum + Number(item.amount),0);
  const scopedExpenseTotal = scopedFinanceEntries.filter(item => item.entry_type === "expense" && item.status === "approved").reduce((sum,item) => sum + Number(item.amount),0);
  const visibleFinanceEntries = financeCategory === "all"
    ? effectiveFinanceEntries
    : scopedFinanceEntries.filter(item => item.entry_type === financeMode);
  const gameReportProducts = gameProducts.map(item=>({...item,label:item.key==="nlh_30k_quantity"&&Number(activeShift?.venue_id)===3?"NLH 40K":item.label,price:gameProductPrice(item,activeShift?.venue_id)}));
  const gameInventoryProducts = gameProducts.map(item=>({...item,label:item.key==="nlh_30k_quantity"&&Number(gameInventoryVenueId)===3?"NLH 40K":item.label,price:gameProductPrice(item,gameInventoryVenueId)}));
  const gameTotalAmount = gameReportProducts.reduce((sum,item)=>sum+Number(gameQuantities[item.key]||0)*item.price,0);
  const gameAmountsValid = gameReportProducts.every(item=>!gameAmounts[item.key] || Number(gameAmounts[item.key]) % item.price === 0);
  const revenueByCategory = Object.fromEntries(["loto","game","water","kiosk","other"].map(category => [
    category,
    effectiveFinanceEntries.filter(item => item.entry_type === "revenue" && item.category === category).reduce((sum,item) => sum + Number(item.amount),0),
  ]));
  const expenseByCategory = Object.fromEntries(["loto","game","water","kiosk","other","payroll"].map(category => [
    category,
    effectiveFinanceEntries.filter(item => item.entry_type === "expense" && item.status === "approved" && item.category === category).reduce((sum,item) => sum + Number(item.amount),0),
  ]));
  const financeVenueName=venues.find(venue=>venue.id===operationalVenueId)?.name||"Sân Khấu";
  const financeTotalRevenue=["loto","game","water","kiosk","other"].reduce((sum,category)=>sum+Number(revenueByCategory[category]||0),0);
  const financeTotalExpense=effectiveFinanceEntries.filter(item=>item.entry_type==="expense"&&item.status==="approved").reduce((sum,item)=>sum+Number(item.amount),0);
  const financeRemaining=financeTotalRevenue-financeTotalExpense;
  const overviewCompanyDayExpense=overviewVenueRevenue.reduce((sum,item)=>sum+Number(item.day_expense||0),0);
  const overviewCompanyWeekExpense=overviewVenueRevenue.reduce((sum,item)=>sum+Number(item.week_expense||0),0);
  const overviewCompanyDayRevenue=overviewVenueRevenue.reduce((sum,item)=>sum+Number(item.day_total||0),0);
  const overviewCompanyWeekRevenue=overviewVenueRevenue.reduce((sum,item)=>sum+Number(item.week_total||0),0);
  const selectedFinanceRange=financeDateRange(financeDate||activeShift?.performance_date||localDateValue(),financePeriod);
  const bonusVenueName=venues.find(v=>v.id===operationalVenueId)?.name||venues.find(v=>v.id===Number(venueId))?.name||"";
  const bonusVenueKey=bonusVenueName.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/đ/g,"d");
  const isGoAnLac=bonusVenueKey.includes("go an lac");
  const overviewBonusVenueName=overviewRevenueSelection&&overviewRevenueSelection!=="company"?venues.find(v=>String(v.id)===overviewRevenueSelection)?.name||bonusVenueName:bonusVenueName;
  const overviewBonusVenueKey=overviewBonusVenueName.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/đ/g,"d");
  const overviewBonusTarget=overviewBonusVenueKey.includes("duc hoa")?90000000:overviewBonusVenueKey.includes("loc ninh")?30000000:overviewBonusVenueKey.includes("go an lac")?10000000:70000000;
  const bonusWeeklyTarget=bonusVenueKey.includes("duc hoa")?90000000:bonusVenueKey.includes("loc ninh")?30000000:70000000;
  const displayedBonusTarget=panel==="overview"?overviewBonusTarget:bonusWeeklyTarget;
  // Ở Tổng Quan, ngày người dùng đang chọn là nguồn duy nhất quyết định chu kỳ thưởng.
  // Không dùng overviewRevenue?.date vì dữ liệu tải bất đồng bộ có thể còn giữ ngày của lần xem trước.
  const bonusReferenceDate=panel==="overview"?overviewRevenueDate:(financeDate||activeShift?.performance_date||localDateValue());
  const bonusCycle=lotoBonusCycleForDate(bonusReferenceDate);
  const bonusMonth=bonusCycle.month;
  // Chu kỳ tiếp tục đến hết Chủ Nhật trước Thứ Hai đầu tiên của tháng kế tiếp.
  // Ví dụ ngày 01–06/09 vẫn thuộc chu kỳ tháng 08, không chuyển sớm sang tháng 09.
  // Tuần không có bản ghi doanh thu vẫn xuất hiện với 0 đồng khi tuần đã kết thúc.
  const periodBonusWeeks=(()=>{
    const cursor=new Date(`${bonusCycle.start}T12:00:00`);
    const rows:BonusWeek[]=[];
    while(inputDate(cursor)<=bonusCycle.end){
      const weekStart=inputDate(cursor);
      const end=new Date(cursor);end.setDate(end.getDate()+6);
      const weekEnd=inputDate(end);
      const stored=bonusWeeks.find(week=>week.week_start===weekStart);
      const useComputedOverviewRevenue=panel==="overview"&&overviewRevenueSelection!==null&&overviewRevenueSelection!=="company"&&overviewRevenue?.weekStart===weekStart;
      const weeklyRevenue=useComputedOverviewRevenue?Number(overviewRevenue?.currentWeek.categories.loto||0):Number(stored?.weekly_revenue||0);
      const target=displayedBonusTarget;
      rows.push(stored?{...stored,weekly_revenue:weeklyRevenue,target_amount:target,achieved:weeklyRevenue>=target}:{week_start:weekStart,week_end:weekEnd,weekly_revenue:weeklyRevenue,target_amount:target,achieved:weeklyRevenue>=target,proposed_bonus:0,settlement_id:null,settlement_date:null,paid_at:null});
      cursor.setDate(cursor.getDate()+7);
    }
    return rows;
  })();
  const completedBonusWeeks=periodBonusWeeks.filter(week=>week.week_end<=localDateValue());
  const achievedBonusWeeks=completedBonusWeeks.filter(week=>Number(week.weekly_revenue||0)>=displayedBonusTarget);
  const missedBonusWeeks=completedBonusWeeks.length-achievedBonusWeeks.length;
  const bonusResponsibleVenueId=overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):operationalVenueId;
  const bonusResponsibleEmployeeId=bonusResponsibleByVenue[bonusResponsibleVenueId]||"";
  const bonusResponsibleEmployee=employees.find(employee=>String(employee.id)===String(bonusResponsibleEmployeeId));
  const normalizedResponsibleName=(bonusResponsibleEmployee?.full_name||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/đ/g,"d").replace(/Đ/g,"d").toLowerCase().trim();
  const responsibilityOffEligible=new Set(["ngoc hoai","huynh duc","minh thu"]).has(normalizedResponsibleName);
  const responsibilityOffDays=responsibilityOffEligible?new Set(responsibilityOffRequests.filter(request=>request.employee_id===bonusResponsibleEmployee?.id&&request.status!=="rejected").map(request=>request.off_date)).size:0;
  const responsibilityExcessOffDays=Math.max(0,responsibilityOffDays-2);
  const targetMissDeduction=missedBonusWeeks*500000;
  const excessOffDeduction=responsibilityExcessOffDays*500000;
  const approvedAdvanceStatuses=new Set(["approved","sent_to_expense","paid"]);
  const responsibleApprovedAdvance=salaryAdvances
    .filter(item=>item.employee_id===bonusResponsibleEmployee?.id
      && item.venue_id===bonusResponsibleVenueId
      && String(item.request_month||"").slice(0,7)===bonusMonth
      && approvedAdvanceStatuses.has(item.status)
      && (item.request_type==="bonus"||Boolean(bonusResponsibleEmployee?.bonus_advance_eligible)))
    .reduce((sum,item)=>sum+Number(item.amount||0),0);
  const monthlyResponsibleBonus=Math.max(0,5000000-targetMissDeduction-excessOffDeduction-responsibleApprovedAdvance);
  const earnedBonusTotal=isGoAnLac?periodBonusWeeks.reduce((sum,week)=>sum+Number(week.proposed_bonus||0),0):monthlyResponsibleBonus;
  const goAnLacShiftLotoRevenue=overviewBonusVenueKey.includes("go an lac")?Number(overviewRevenue?.current.categories.loto||0):0;
  const goAnLacBonus=goAnLacShiftLotoRevenue>=10000000?Math.round(goAnLacShiftLotoRevenue*0.1):0;
  const paidBonusTotal=periodBonusWeeks.filter(week=>week.settlement_id).reduce((sum,week)=>sum+Number(week.proposed_bonus||0),0);
  const todayForBonus=new Date(localDateValue()+"T00:00:00");
  let nextBonusSettlement=firstSunday(todayForBonus.getFullYear(),todayForBonus.getMonth());
  if (todayForBonus>nextBonusSettlement) nextBonusSettlement=firstSunday(todayForBonus.getFullYear(),todayForBonus.getMonth()+1);
  const canSettleToday=todayForBonus.getDay()===0&&todayForBonus.getDate()<=7;
  const kioskNumber=(value:string)=>Number(value.replace(/\D/g,""))||0;
  const displayVietnameseDate=(value:string)=>{
    const match=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match?`${match[3]}/${match[2]}/${match[1]}`:value;
  };
  const parseVietnameseDate=(value:string)=>{
    const match=value.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (!match) return null;
    const day=Number(match[1]),month=Number(match[2]),year=Number(match[3]);
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`:null;
  };
  const overdueKioskBills=kioskBills.filter(bill=>bill.payment_status==="unpaid"&&bill.due_date<localDateValue());
  const overviewComparison=(previous:number)=>{
    const current=overviewRevenue?.current.total||0;
    const difference=current-previous;
    return{difference,percent:previous===0?null:(difference/Math.abs(previous))*100};
  };
  const yesterdayComparison=overviewComparison(overviewRevenue?.yesterday.total||0);
  const previousWeekTotal=overviewRevenue?.previousWeek.total||0;
  const currentWeekTotal=overviewRevenue?.currentWeek.total||0;
  const previousWeekDifference=currentWeekTotal-previousWeekTotal;
  const previousWeekComparison={difference:previousWeekDifference,percent:previousWeekTotal===0?null:(previousWeekDifference/Math.abs(previousWeekTotal))*100};
  const overviewCategoryLabels:Record<string,string>={loto:"Loto",game:"Trò Chơi",water:"Quán Nước",kiosk:"Kios",other:"Khác"};

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setReady(true); });
    if ("serviceWorker" in navigator&&process.env.NODE_ENV==="production") navigator.serviceWorker.register("/sw.js",{updateViaCache:"none"});
    return () => data.subscription.unsubscribe();
  }, [supabase]);

  useEffect(()=>{
    if(!session?.user.id||!profile?.business_id)return;
    const refreshFromAnotherMachine=(payload:any)=>{
      if(payload.new?.actor_user_id===session.user.id)return;
      const active=document.activeElement;
      const editing=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement||active instanceof HTMLSelectElement;
      if(panel==="ticketReport"){
        // Đối chiếu vé là phiên thao tác chủ động. Không tự tải lại khi máy khác
        // đồng bộ, vì lượt tải nền có thể xóa phiên đang chọn hoặc chen vào lúc
        // người dùng đang nhập tồn thực tế. Người dùng chủ động bấm Làm Mới;
        // sau lần lưu của chính mình, màn hình vẫn tự cập nhật như bình thường.
        return;
      }
      if(editing||ticketLocalDirtyRef.current)return;
    };
    const channel=supabase.channel(`business-live-sync-${profile.business_id}-${session.user.id}`)
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"business_sync_events",filter:`business_id=eq.${profile.business_id}`},refreshFromAnotherMachine)
      .subscribe();
    return()=>{if(remoteReloadTimerRef.current)window.clearTimeout(remoteReloadTimerRef.current);void supabase.removeChannel(channel);};
  },[session?.user.id,profile?.business_id,panel,reportVenueId,reportVarianceOnly,reportHistoryMode,reportHistoryDate,supabase]);

  useEffect(() => {
    const updateNetworkState=()=>setIsOnline(navigator.onLine);
    const flushOfflineDrafts=async()=>{
      setIsOnline(true);
      const pending=await getPendingOfflineTicketDrafts().catch(()=>[]);
      for(const draft of pending){
        const payload=draft.payload as TicketShiftDraft;
        const {error}=await supabase.from("ticket_shift_drafts").upsert({
          shift_id:draft.shiftId,business_id:draft.businessId,venue_id:draft.venueId,payload,
          extra_roles:payload.extraRoles||{organ:"",ticketChecker:""},updated_by:draft.updatedBy||null,updated_at:draft.savedAt,
        },{onConflict:"shift_id"});
        if(!error)await markOfflineTicketDraftSynced(draft.shiftId,draft.savedAt).catch(()=>undefined);
      }
      if(pending.length)setTicketDraftStatus("saved");
    };
    updateNetworkState();
    window.addEventListener("offline",updateNetworkState);
    window.addEventListener("online",flushOfflineDrafts);
    if(navigator.onLine)void flushOfflineDrafts();
    return()=>{window.removeEventListener("offline",updateNetworkState);window.removeEventListener("online",flushOfflineDrafts);};
  },[supabase]);
  useEffect(() => {
    const stopQuantityWheel = (event: WheelEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "number" && target.closest(".staff-quantity-cell")) {
        event.preventDefault();
        target.blur();
      }
    };
    document.addEventListener("wheel", stopQuantityWheel, { passive: false });
    return () => document.removeEventListener("wheel", stopQuantityWheel);
  }, []);

  useEffect(()=>{
    const validPanels=new Set(["publicHome","overview","module","ticketSetup","ticketHistory","tickets","ticketReport","gameReport","gameInventory","finance","expenseCenter","kioskRevenue","staffManagement","lotoAttendance","approvals","users","publicGallery"]);
    const restoreRoute=(source:"initial"|"history"|"hash"="initial")=>{
      const params=new URLSearchParams(window.location.hash.replace(/^#/,""));
      const requested=params.get("view");
      // Báo Cáo Vé có dữ liệu đang lưu theo từng vòng. Không để một hashchange
      // phát sinh nền (đồng bộ, service worker hoặc tab khác) đá người dùng ra
      // khỏi màn hình đang đối chiếu. Điều hướng bằng nút ứng dụng và Back/Forward
      // vẫn dùng state hoặc popstate nên không bị ảnh hưởng.
      if(source==="hash"&&visiblePanelRef.current==="ticketReport"&&requested&&requested!=="ticketReport")return;
      restoringRouteRef.current=true;
      if(requested&&validPanels.has(requested))setPanel(requested as typeof panel);
      const section=params.get("section");if(section)setModuleSection(section);
      const tab=params.get("tab");if(tab==="advance")setPanel("expenseCenter");else if(tab&&["directory","mySchedule","schedule","costume","off","competition","attendance","payroll","requests"].includes(tab))setPersonnelTab(tab as typeof personnelTab);
      window.setTimeout(()=>{restoringRouteRef.current=false;routeReadyRef.current=true;},0);
    };
    restoreRoute();
    const restoreFromHistory=()=>restoreRoute("history");
    const restoreFromHash=()=>restoreRoute("hash");
    window.addEventListener("popstate",restoreFromHistory);
    window.addEventListener("hashchange",restoreFromHash);
    return()=>{window.removeEventListener("popstate",restoreFromHistory);window.removeEventListener("hashchange",restoreFromHash);};
  },[]);

  useEffect(()=>{visiblePanelRef.current=panel;},[panel]);

  useEffect(()=>{
    if(profile&&profile.role!=="owner"&&(panel==="ticketInventoryEntry"||panel==="gameInventory")){
      setPanel("module");
      setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé hoặc sửa số lượng tồn.");
    }
  },[panel,profile]);

  useEffect(()=>{
    if(profile?.role!=="employee")return;
    if(panel==="module"){
      setModuleSection("Nhân Sự Tư Hậu");
      setPanel("staffManagement");
    }
    if(!employeePersonnelTabs.includes(personnelTab as typeof employeePersonnelTabs[number])||(personnelTab==="schedule"&&!isLotoScheduleViewer)){
      setPersonnelTab("mySchedule");
    }
  },[profile?.role,personnelTab,panel,isLotoScheduleViewer]);

  useEffect(()=>{
    if(profile?.role!=="employee"||!profile.employee_id||panel!=="staffManagement"||personnelTab!=="directory")return;
    setDirectoryEmployeeId(profile.employee_id);
    setDirectoryEmployeeView("costume");
    void loadStaffCompetition(scoreMonth);
  },[profile?.role,profile?.employee_id,panel,personnelTab,scoreMonth]);

  useEffect(()=>{
    if(!routeReadyRef.current||restoringRouteRef.current)return;
    const params=new URLSearchParams();params.set("view",panel);
    if(moduleSection)params.set("section",moduleSection);
    if(panel==="staffManagement")params.set("tab",personnelTab);
    const nextHash=`#${params.toString()}`;
    if(window.location.hash!==nextHash)window.history.pushState({panel},"",nextHash);
  },[panel,moduleSection,personnelTab]);

  useEffect(()=>{
    if(personnelTab!=="costume")return;
    const storageKey=`tu-hau-costume-plan-v2:${profile?.business_id||"local"}:${costumePlanMonth}`;
    try {
      const saved=window.localStorage.getItem(storageKey);
      if(saved){setCostumePlan(JSON.parse(saved));return;}
    } catch { /* Tạo lịch mới nếu bản nháp cục bộ không đọc được. */ }
    setCostumePlan(generateCostumePlan(costumePlanMonth));
  },[personnelTab,costumePlanMonth,profile?.business_id]);

  useEffect(()=>{
    if(personnelTab!=="costume"||costumePlan.length===0)return;
    const storageKey=`tu-hau-costume-plan-v2:${profile?.business_id||"local"}:${costumePlanMonth}`;
    try { window.localStorage.setItem(storageKey,JSON.stringify(costumePlan)); } catch { /* Không chặn thao tác khi trình duyệt chặn lưu cục bộ. */ }
  },[costumePlan,personnelTab,costumePlanMonth,profile?.business_id]);

  useEffect(()=>{
    if(personnelTab!=="costume"||!profile)return;
    void loadCostumePlanReferences();
  },[personnelTab,costumePlanMonth,profile?.business_id]);

  useEffect(()=>{
    if(panel!=="expenseCenter"||!profile)return;
    const allowedVenue=profile.role==="manager"?profile.venue_id:profile.role==="employee"?linkedExpenseEmployee?.account_venue_id:(Number(expenseCenterVenueId)||profile.venue_id||venues[0]?.id);
    if(allowedVenue&&String(allowedVenue)!==expenseCenterVenueId)setExpenseCenterVenueId(String(allowedVenue));
    if(profile.role==="employee"){setExpenseCenterCategory("payroll");if(profile.employee_id)setExpenseCenterEmployeeId(String(profile.employee_id));}
    void loadSalaryAdvances();
    if(profile.role!=="employee")void loadFixedExpenses();
    if(allowedVenue)setFixedExpenseForm(current=>({...current,venueId:String(allowedVenue)}));
  },[panel,profile?.business_id,profile?.venue_id,venues.length]);

  useEffect(()=>{
    if(panel!=="overview"||!profile)return;
    void loadSalaryAdvances(overviewRevenueDate);
  },[panel,profile?.business_id,profile?.venue_id,overviewRevenueDate]);

  useEffect(() => {
    let active=true;
    supabase.rpc("public_homepage_highlights").then(({data,error})=>{
      if(!active)return;
      if(!error&&data){const highlights=data as PublicHighlights;setPublicHighlights({...highlights,gallery:(highlights.gallery||[]).slice(0,12)});}
      setPublicLoading(false);
    });
    return()=>{active=false;};
  },[supabase]);

  async function refreshPublicHomepage(){
    const {data,error}=await supabase.rpc("public_homepage_highlights");
    if(!error&&data){const highlights=data as PublicHighlights;setPublicHighlights({...highlights,gallery:(highlights.gallery||[]).slice(0,12)});}
    setPublicLoading(false);
  }

  async function loadPublicAlbumAdmin(){
    const {data,error}=await supabase.from("public_activity_gallery").select("id,image_path,caption,is_published,published_at,created_at").eq("business_id",1).order("created_at",{ascending:false});
    if(error){setMessage(error.message);return;}
    const rows=(data||[]) as PublicAlbumItem[];
    if(profile?.role==="manager"){
      const venueName=venues.find(venue=>venue.id===profile.venue_id)?.name;
      setPublicAlbumItems(venueName?rows.filter(item=>String(item.caption||"").startsWith(`Sân khấu: ${venueName}`)):[]);
      return;
    }
    setPublicAlbumItems(rows);
  }

  async function openPublicAlbumAdmin(){
    setPanel("publicGallery");
    setMessage("");
    await loadPublicAlbumAdmin();
  }

  async function uploadPublicAlbum(){
    if(!session||!profile||profile.role!=="manager"||!profile.venue_id||!albumFiles.length||albumUploading)return;
    setAlbumUploading(true);setMessage("");
    const staged:Array<{path:string;caption:string}>=[];
    const managerVenueName=venues.find(venue=>venue.id===profile.venue_id)?.name||"Sân Khấu Chưa Xác Định";
    const publicCaption=`Sân khấu: ${managerVenueName}${albumCaption.trim()?` — ${albumCaption.trim()}`:""}`;
    for(const file of albumFiles.slice(0,20)){
      const extension=file.name.split(".").pop()?.toLowerCase()||"jpg";
      const path=`1/public-staging/${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const {error}=await supabase.storage.from("staff-media").upload(path,file,{contentType:file.type,upsert:false});
      if(error){setMessage(error.message);setAlbumUploading(false);return;}
      staged.push({path,caption:publicCaption});
    }
    const {error}=await supabase.functions.invoke("publish-public-album",{body:{files:staged}});
    if(error)setMessage(error.message);else{
      setMessage(`Đã xuất bản ${staged.length} ảnh vào album Hoạt Động Của Đoàn.`);
      setAlbumFiles([]);setAlbumCaption("");
      await Promise.all([loadPublicAlbumAdmin(),refreshPublicHomepage()]);
    }
    setAlbumUploading(false);
  }

  useEffect(() => {
    setManagerVenueChosen(false);
    if (session) loadWorkspace();
    else setProfile(null);
  // Token refresh must not reload/switch the ticket workspace or discard drafts.
  // Only initialize again when the signed-in account itself changes.
  }, [session?.user.id]);

  const ticketShiftStorageKey=(businessId:number,userId=session?.user.id)=>userId?`tu-hau-ticket-shift:${businessId}:${userId}`:"";
  const rememberTicketShift=(shift:Shift|null,businessId=profile?.business_id)=>{
    activeShiftRef.current=shift;
    setActiveShift(shift);
    if(typeof window==="undefined"||!businessId)return;
    const key=ticketShiftStorageKey(businessId);
    if(!key)return;
    if(shift)sessionStorage.setItem(key,JSON.stringify({shift_id:shift.id,venue_id:shift.venue_id}));
    else sessionStorage.removeItem(key);
  };
  const recalledTicketShift=(businessId:number,shifts:Shift[])=>{
    if(typeof window==="undefined")return null;
    const key=ticketShiftStorageKey(businessId);
    if(!key)return null;
    try{
      const saved=JSON.parse(sessionStorage.getItem(key)||"null") as {shift_id?:number;venue_id?:number}|null;
      return saved?shifts.find(shift=>shift.id===Number(saved.shift_id)&&shift.venue_id===Number(saved.venue_id))||null:null;
    }catch{return null;}
  };
  useEffect(()=>{
    activeShiftRef.current=activeShift;
    if(typeof window==="undefined"||!profile?.business_id)return;
    const key=ticketShiftStorageKey(profile.business_id);
    if(!key)return;
    if(activeShift)sessionStorage.setItem(key,JSON.stringify({shift_id:activeShift.id,venue_id:activeShift.venue_id}));
    else sessionStorage.removeItem(key);
  },[activeShift?.id,activeShift?.venue_id,profile?.business_id,session?.user.id]);

  useEffect(()=>{
    if(panel!=="tickets")return;
    const updateViewport=()=>setTicketViewportWidth(document.documentElement.clientWidth||window.innerWidth);
    updateViewport();
    window.addEventListener("resize",updateViewport,{passive:true});
    return()=>window.removeEventListener("resize",updateViewport);
  },[panel]);

  useEffect(()=>{
    if(panel!=="tickets")return;
    const block=ticketFixedControlRef.current;
    const workspace=block?.closest(".ticket-workspace") as HTMLElement|null;
    const siteHeader=document.querySelector(".site-header") as HTMLElement|null;
    if(!block||!workspace)return;
    const updateLayout=()=>{
      const nextHeight=`${Math.ceil(block.getBoundingClientRect().height)}px`;
      if(workspace.style.getPropertyValue("--ticket-fixed-control-height")!==nextHeight){
        workspace.style.setProperty("--ticket-fixed-control-height",nextHeight);
      }
      const nextHeaderHeight=`${Math.ceil(siteHeader?.getBoundingClientRect().height||0)}px`;
      if(workspace.style.getPropertyValue("--fixed-site-header-height")!==nextHeaderHeight){
        workspace.style.setProperty("--fixed-site-header-height",nextHeaderHeight);
      }
    };
    updateLayout();
    const observer=new ResizeObserver(updateLayout);
    observer.observe(block);
    if(siteHeader)observer.observe(siteHeader);
    window.addEventListener("resize",updateLayout);
    return()=>{
      observer.disconnect();
      window.removeEventListener("resize",updateLayout);
      workspace.style.removeProperty("--fixed-site-header-height");
    };
  },[panel,editingShiftStaff,shiftStaff.length,ticketZoom,ticketReadOnly]);

  useEffect(()=>{
    if(panel!=="ticketSetup"||!venues.length)return;
    const openVenueIds=new Set(openVenueShifts.map(shift=>shift.venue_id));
    const selectableVenues=venues.filter(venue=>(profile?.role!=="manager"||venue.id===profile?.venue_id)&&!openVenueIds.has(venue.id));
    if(venueId&&!openVenueIds.has(Number(venueId))&&selectableVenues.some(venue=>venue.id===Number(venueId)))return;
    setVenueId(selectableVenues[0]?String(selectableVenues[0].id):"");
  },[panel,venues,openVenueShifts,profile?.role,profile?.venue_id,venueId]);

  async function loadWorkspace(forcedVenueId?:number) {
    setMessage("");
    const userId = session!.user.id;
    const { data: profileData, error } = await supabase.from("profiles").select("business_id,role,status,username,access_level,venue_id,employee_id,allowed_modules,must_change_password").eq("user_id", userId).single();
    if (error || !profileData) { setMessage("Không đọc được quyền tài khoản."); return; }
    const effectiveManagerVenueId=profileData.role==="manager"?Number(forcedVenueId||profileData.venue_id||0):0;
    const effectiveProfile=profileData.role==="manager"&&effectiveManagerVenueId
      ? {...profileData,venue_id:effectiveManagerVenueId}
      : profileData;
    setProfile(effectiveProfile);
    if(profileData.role==="employee"){
      setModuleSection("Nhân Sự Tư Hậu");setPersonnelTab("mySchedule");setPanel("staffManagement");
    }
    // Chỉ tài khoản nhân viên bị giới hạn vào hồ sơ của chính mình.
    // Chủ sở hữu/quản lý có thể được liên kết với một hồ sơ nhân sự nhưng vẫn
    // phải mở được danh sách toàn bộ nhân sự.
    setDirectoryEmployeeId(profileData.role==="employee"&&profileData.employee_id?profileData.employee_id:null);
    if(profileData.role==="employee"){
      setModuleSection("Nhân Sự Tư Hậu");
      setPersonnelTab("mySchedule");
      setPanel("staffManagement");
    }
    if (profileData.status !== "active") return;
    let employeeQuery=supabase.from("employees").select("id,full_name,is_active,joined_on,department,loto_role,pay_type,monthly_salary,hourly_rate,daily_rate,weekday_case,weekend_case,holiday_case,tet_case,half_case,attendance_enabled,scheduling_level,scheduling_symbol,scheduling_note,payroll_closing_day,salary_payment_day,weekly_payment_weekday,responsibility_amount,bonus_amount,bonus_advance_eligible,bonus_advance_limit,responsibility_target_required,weekly_hourly_rate,weekly_salary,weekend_hourly_rate,holiday_hourly_rate,daily_weekend_rate,daily_holiday_rate,account_access_level,account_venue_id,job_title").eq("is_active", true).order("full_name");
    // Nhân viên chỉ nhận thông tin cần thiết để xem lịch; chính sách dữ liệu
    // chỉ trả về toàn bộ hồ sơ Loto khi người đăng nhập cũng thuộc bộ phận Loto.
    // Không tải lương hoặc thông tin hợp đồng của người khác về điện thoại.
    if(profileData.role==="employee")employeeQuery=supabase.from("employees").select("id,full_name,is_active,joined_on,department,loto_role,attendance_enabled,scheduling_level,scheduling_symbol,scheduling_note,account_venue_id,job_title").eq("is_active",true).order("full_name");
    const venueRequest=profileData.role==="manager"
      ? supabase.rpc("list_manager_venues")
      : supabase.from("venues").select("id,name,attendance_latitude,attendance_longitude,attendance_radius_m,attendance_wifi_ips,attendance_configured_at,is_active").eq("is_active", true).order("name");
    const [{ data: venueData, error: venueError }, { data: employeeData, error: employeeError }] = await Promise.all([
      venueRequest,
      employeeQuery,
    ]);
    if(venueError){setMessage("Không tải được danh sách sân khấu được cấp quyền.");return;}
    // Khi một trường hồ sơ mới chưa có ở máy khách cũ, vẫn phải tải được
    // danh sách cơ bản để mở File Vé và chọn đầy đủ nhân sự Loto.
    let visibleEmployees=employeeData||[];
    if(employeeError){
      const {data:fallbackEmployees,error:fallbackError}=await supabase.from("employees").select("id,full_name,is_active,joined_on,department,loto_role,attendance_enabled,scheduling_level,scheduling_symbol,scheduling_note,account_venue_id,job_title").eq("is_active",true).order("full_name");
      if(fallbackError){setMessage("Không tải được danh sách nhân sự: "+fallbackError.message);return;}
      visibleEmployees=fallbackEmployees||[];
    }
    setVenues((venueData||[]).map((venue:any)=>({...venue,id:Number(venue.id)})) as Venue[]); setEmployees(visibleEmployees as Employee[]);
    const {data:bonusResponsibleRows}=await supabase
      .from("venue_loto_bonus_settings")
      .select("venue_id,responsible_employee_id")
      .eq("business_id",profileData.business_id);
    setBonusResponsibleByVenue(Object.fromEntries((bonusResponsibleRows||[]).map(row=>[
      Number(row.venue_id),
      row.responsible_employee_id ? String(row.responsible_employee_id) : "",
    ])));
    const managerWaitingForVenue=false;
    let allOpenQuery=supabase.from("shifts").select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").eq("business_id",profileData.business_id).eq("status","open").order("opened_at",{ascending:false});
    if(profileData.role==="manager")allOpenQuery=allOpenQuery.eq("venue_id",effectiveManagerVenueId||0);
    const {data:allOpenRows}=await allOpenQuery;
    const now=Date.now();
    const expired=(allOpenRows||[]).filter((shift:Shift)=>now-new Date(shift.opened_at).getTime()>12*60*60*1000);
    const closeResults=await Promise.all(expired.map(async(shift:Shift)=>({shift,error:(await supabase.rpc("close_ticket_shift",{p_shift_id:shift.id})).error})));
    const closedIds=new Set(closeResults.filter(result=>!result.error).map(result=>result.shift.id));
    const currentOpen=(allOpenRows||[]).filter((shift:Shift)=>!closedIds.has(shift.id)) as Shift[];
    setOpenVenueShifts(currentOpen.map(shift=>({...shift,id:Number(shift.id),venue_id:Number(shift.venue_id)})));
    if(currentOpen.length){
      const {data:staffRows}=await supabase.from("shift_staff").select("shift_id").in("shift_id",currentOpen.map(shift=>shift.id));
      setShiftStaffCounts((staffRows||[]).reduce((counts:Record<number,number>,row:any)=>({...counts,[row.shift_id]:(counts[row.shift_id]||0)+1}),{}));
    }else setShiftStaffCounts({});
    const operatorIds=[...new Set(currentOpen.map(shift=>shift.opened_by).filter(Boolean))] as string[];
    if(operatorIds.length){
      const {data:operators}=await supabase.from("profiles").select("user_id,full_name,username").in("user_id",operatorIds);
      setShiftOperatorNames(Object.fromEntries((operators||[]).map(item=>[item.user_id,item.full_name||item.username||"Tài Khoản Quản Lý"])));
    }else setShiftOperatorNames({});
    if(managerWaitingForVenue){rememberTicketShift(null,profileData.business_id);return;}
    // Ca đang thao tác là trạng thái riêng của từng tab. Không chọn "ca mới nhất"
    // trên toàn công ty vì cập nhật từ sân khấu khác sẽ làm đổi File Vé đang mở.
    const previousShift=activeShiftRef.current;
    const retained=previousShift&&currentOpen.find(shift=>shift.id===previousShift.id&&shift.venue_id===previousShift.venue_id);
    const recalled=recalledTicketShift(profileData.business_id,currentOpen);
    const ownShift=currentOpen.find(shift=>shift.opened_by===userId)||null;
    const shiftData=retained||recalled||ownShift||null;
    rememberTicketShift(shiftData,profileData.business_id);
    if(shiftData?.venue_id)setVenueId(String(shiftData.venue_id));
    setAttendanceVenueId(String(effectiveManagerVenueId||shiftData?.venue_id||venueData?.[0]?.id||""));
    const workDate=shiftData?.performance_date || "";
    setShiftWorkDate(workDate); setFinanceDate(workDate); setGameReportDate(workDate); if(workDate)setKioskPaidDate(workDate);
    setKinhTrung(shiftData?.kinh_trung_amount ? String(shiftData.kinh_trung_amount) : "");
    // Chỉ ghi nhớ ca ở bước khởi tạo. Kho, vòng vé và bản nháp chỉ tải khi người dùng mở File Vé.
    if (profileData.role === "owner" || profileData.role === "manager") await Promise.all([loadApprovals(),loadWorkforceStats(profileData.business_id)]);
  }

  async function loadOverviewTicketVariances(businessId=profile?.business_id,managerVenueId=profile?.role==="manager"?profile.venue_id:null) {
    if(!businessId){setOverviewTicketVariances([]);return;}
    setOverviewTicketVarianceLoading(true);
    let shiftQuery=supabase.from("shifts").select("id,venue_id").eq("business_id",businessId).gte("performance_date",REVENUE_REPORTING_START);
    if(managerVenueId)shiftQuery=shiftQuery.eq("venue_id",managerVenueId);
    const {data:shiftRows,error:shiftError}=await shiftQuery;
    if(shiftError){setOverviewTicketVarianceLoading(false);setMessage("Không thể tải đối chiếu File Vé.");return;}
    const shifts=(shiftRows||[]) as {id:number;venue_id:number}[];
    const shiftVenueById=new Map(shifts.map(shift=>[Number(shift.id),Number(shift.venue_id)]));
    const shiftIds=shifts.map(shift=>Number(shift.id));
    const initial=Object.fromEntries((managerVenueId?venues.filter(venue=>venue.id===managerVenueId):venues).map(venue=>[venue.id,{venue_id:venue.id,total_rounds:0,reported_rounds:0,mismatch_rounds:0,surplus_rounds:0,shortage_rounds:0,surplus_tickets:0,shortage_tickets:0,defective_rounds:0,defective_tickets:0} as OverviewTicketVariance]));
    if(shiftIds.length===0){setOverviewTicketVariances(Object.values(initial));setOverviewTicketVarianceLoading(false);return;}
    const {data,error}=await supabase.from("ticket_rounds").select("shift_id,status,opening_quantity,sold_quantity,reconciliation_confirmed_at,reconciliation_variance,ticket_round_codes(actual_remaining,defective_quantity,cancellation_status)").in("shift_id",shiftIds);
    if(error){setOverviewTicketVarianceLoading(false);setMessage("Không thể tải đối chiếu File Vé.");return;}
    for(const round of (data||[]) as any[]){
      const venueId=shiftVenueById.get(Number(round.shift_id));
      const codes=Array.isArray(round.ticket_round_codes)?round.ticket_round_codes:[];
      if(!venueId||codes.length===0)continue;
      const reconciliation=ticketRoundReconciliation({...round,ticket_round_codes:codes} as ReportRound);
      if(reconciliation.activeCodes.length===0||!reconciliation.hasSale)continue;
      const summary=initial[venueId]||(initial[venueId]={venue_id:venueId,total_rounds:0,reported_rounds:0,mismatch_rounds:0,surplus_rounds:0,shortage_rounds:0,surplus_tickets:0,shortage_tickets:0,defective_rounds:0,defective_tickets:0});
      summary.total_rounds+=1;
      if(!reconciliation.hasValidReport)continue;
      summary.reported_rounds+=1;
      if(!reconciliation.hasOutstandingVariance)continue;
      summary.mismatch_rounds+=1;
      if(reconciliation.defectiveTickets>0){summary.defective_rounds+=1;summary.defective_tickets+=reconciliation.defectiveTickets;}
      if(reconciliation.variance>0){summary.shortage_rounds+=1;summary.shortage_tickets+=reconciliation.variance;}
      else if(reconciliation.variance<0){summary.surplus_rounds+=1;summary.surplus_tickets+=Math.abs(reconciliation.variance);}
    }
    setOverviewTicketVariances(Object.values(initial).sort((a,b)=>b.mismatch_rounds-a.mismatch_rounds));
    setOverviewTicketVarianceLoading(false);
  }

  async function loadOverviewTicketStocks(businessId=profile?.business_id,managerVenueId=profile?.role==="manager"?profile.venue_id:null) {
    if(!businessId){setOverviewTicketStocks([]);return;}
    const {data,error}=await supabase.rpc("get_ticket_inventory_alerts");
    if(error){setMessage("Không thể tải cảnh báo tồn mã vé.");return;}
    setOverviewTicketStocks(((data||[]) as any[]).map(row=>({
      venue_id:Number(row.venue_id),
      available_codes:Number(row.available_codes||0),
      source_configured:Boolean(row.source_configured),
      stale_codes:Array.isArray(row.stale_codes)?row.stale_codes.map((item:any)=>({code:String(item.code||""),quantity:Number(item.quantity||0),last_used_date:item.last_used_date||null,days_unused:Number(item.days_unused||0)})):[],
    })));
  }

  async function loadShiftTicketStockAlert(shift=activeShift) {
    if(!shift){setShiftTicketStockAlert(null);return;}
    const {data,error}=await supabase.rpc("get_ticket_inventory_alert_for_venue",{p_venue_id:shift.venue_id});
    if(error){setShiftTicketStockAlert(null);return;}
    const row=(data||[])[0] as any;
    if(!row){setShiftTicketStockAlert(null);return;}
    setShiftTicketStockAlert({
      venue_id:Number(row.venue_id),available_codes:Number(row.available_codes||0),source_configured:Boolean(row.source_configured),
      stale_codes:Array.isArray(row.stale_codes)?row.stale_codes.map((item:any)=>({code:String(item.code||""),quantity:Number(item.quantity||0),last_used_date:item.last_used_date||null,days_unused:Number(item.days_unused||0)})):[],
    });
  }

  async function openOverviewTicketVariance(selectedVenueId:number){
    setVenueId(String(selectedVenueId));setReportVenueId(String(selectedVenueId));setReportVarianceOnly(true);setModuleSection("Tổng Quan");setActiveMenu(null);setPanel("ticketReport");
    await loadPendingTicketReportShifts(String(selectedVenueId),true,true);
  }
  async function chooseManagerVenue(selectedVenueId:number){
    if(!profile||profile.role!=="manager")return;
    setManagerVenueLoading(true);setMessage("");
    const {data,error}=await supabase.rpc("select_manager_venue",{p_venue_id:selectedVenueId});
    if(error){setMessage("Không thể chọn sân khấu làm việc. Vui lòng thử lại.");setManagerVenueLoading(false);return;}
    const confirmedVenueId=Number(data||selectedVenueId);
    setProfile(current=>current?{...current,venue_id:confirmedVenueId}:current);
    setVenueId(String(confirmedVenueId));setAttendanceVenueId(String(confirmedVenueId));
    await loadWorkspace(confirmedVenueId);
    setManagerVenueChosen(true);setModuleSection("Tổng Quan");setPanel("overview");
    setManagerVenueLoading(false);
  }

  async function loadWorkforceStats(businessId=profile?.business_id){
    if(!businessId)return;const monthStart=localDateValue().slice(0,7)+"-01";const nextMonth=inputDate(new Date(Number(monthStart.slice(0,4)),Number(monthStart.slice(5,7)),1));
    const {data,error}=await supabase.from("employees").select("is_active,joined_on,left_on").eq("business_id",businessId);if(error)return;
    const rows=(data||[]) as Array<{is_active:boolean;joined_on:string|null;left_on:string|null}>;setWorkforceStats({active:rows.filter(row=>row.is_active).length,joinedThisMonth:rows.filter(row=>row.joined_on&&row.joined_on>=monthStart&&row.joined_on<nextMonth).length,leftThisMonth:rows.filter(row=>row.left_on&&row.left_on>=monthStart&&row.left_on<nextMonth).length});
  }

  async function loadOverviewRevenue(shift:Shift|null=activeShift, venueOverride?:number|null, dateOverride?:string) {
    if(profile?.role!=="owner"&&profile?.role!=="manager"){
      setOverviewRevenue(null);setOverviewVenueRevenue([]);setOverviewRevenueSelection(null);return;
    }
    const date=dateOverride&&/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)
      ? dateOverride
      : shift?.performance_date&&/^\d{4}-\d{2}-\d{2}$/.test(shift.performance_date)
        ? shift.performance_date
        : localDateValue();
    setOverviewRevenueLoading(true);
    const yesterdayDate=dateByDays(date,-1);
    const currentDateObj=new Date(`${date}T12:00:00`); const mondayOffset=(currentDateObj.getDay()+6)%7;
    const currentWeekStart=dateByDays(date,-mondayOffset); const previousWeekStart=dateByDays(currentWeekStart,-7); const previousWeekEnd=dateByDays(currentWeekStart,-1);
    const currentMonthStart=`${date.slice(0,7)}-01`; const requestedQueryStart=currentMonthStart<previousWeekStart?currentMonthStart:previousWeekStart;
    const queryStart=requestedQueryStart<REVENUE_REPORTING_START?REVENUE_REPORTING_START:requestedQueryStart;
    const previousWeekDate=previousWeekEnd;
    const targetVenue=venueOverride===undefined?(shift?.venue_id??(venueId?Number(venueId):null)):venueOverride;
    const businessId=shift?.business_id||profile?.business_id;
    const empty=():RevenueSnapshot=>({total:0,categories:{loto:0,game:0,water:0,kiosk:0,other:0}});
    if(!businessId||date<REVENUE_REPORTING_START){setOverviewRevenue({date,yesterdayDate,previousWeekDate,weekStart:currentWeekStart,weekEnd:date,monthStart:currentMonthStart,current:empty(),currentWeek:empty(),currentMonth:empty(),yesterday:empty(),previousWeek:empty()});setOverviewVenueRevenue([]);setOverviewRevenueLoading(false);return;}
    const rewardCycle=lotoBonusCycleForDate(date);
    const {data:responsibilityOffRows,error:responsibilityOffError}=await supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at").eq("business_id",businessId).gte("off_date",rewardCycle.start).lte("off_date",rewardCycle.end).neq("status","rejected");
    if(responsibilityOffError){setMessage(responsibilityOffError.message);setOverviewRevenueLoading(false);return;}
    setResponsibilityOffRequests((responsibilityOffRows||[]) as TimeOffRequest[]);
    let revenueQuery=supabase.from("finance_entries").select("entry_date,category,amount,venue_id,note,status").eq("business_id",businessId).eq("entry_type","revenue").eq("status","approved").gte("entry_date",queryStart).lte("entry_date",date);
    if(targetVenue!==null) revenueQuery=revenueQuery.eq("venue_id",targetVenue);
    const {data,error}=await revenueQuery;
    if(error){setMessage(error.message);setOverviewRevenueLoading(false);return;}
    // Doanh thu Loto phải lấy từ File Vé thật của đúng sân khấu/phiên.
    // Không dùng bản ghi finance_entries cũ vì có thể còn phiên trùng hoặc phiên trống.
    let shiftQuery=supabase.from("shifts").select("id,venue_id,performance_date,kinh_trung_amount").eq("business_id",businessId).gte("performance_date",queryStart).lte("performance_date",date);
    if(targetVenue!==null)shiftQuery=shiftQuery.eq("venue_id",targetVenue);
    const {data:revenueShifts,error:shiftRevenueError}=await shiftQuery;
    if(shiftRevenueError){setMessage(shiftRevenueError.message);setOverviewRevenueLoading(false);return;}
    const revenueShiftIds=(revenueShifts||[]).map(row=>Number(row.id));
    let lotoRows:Array<{entry_date:string;category:string;amount:number;venue_id:number}>=[];
    if(revenueShiftIds.length){
      const [{data:revenueRounds,error:roundRevenueError},{data:revenueStaff,error:staffRevenueError},{data:revenueDrafts,error:draftRevenueError}]=await Promise.all([
        supabase.from("ticket_rounds").select("id,shift_id,ticket_price,sold_quantity,gross_amount,gift_value").in("shift_id",revenueShiftIds),
        supabase.from("shift_staff").select("shift_id,employee_id,case_amount,allowance").in("shift_id",revenueShiftIds),
        supabase.from("ticket_shift_drafts").select("shift_id,extra_roles,payload").in("shift_id",revenueShiftIds)
      ]);
      if(roundRevenueError||staffRevenueError||draftRevenueError){setMessage((roundRevenueError||staffRevenueError||draftRevenueError)?.message||"Không thể tải doanh thu File Vé.");setOverviewRevenueLoading(false);return;}
      const roundIds=(revenueRounds||[]).map(row=>Number(row.id));
      const {data:revenueCodes,error:codeRevenueError}=roundIds.length
        ? await supabase.from("ticket_round_codes").select("round_id").in("round_id",roundIds)
        : {data:[],error:null};
      if(codeRevenueError){setMessage(codeRevenueError.message);setOverviewRevenueLoading(false);return;}
      const codedRoundIds=new Set((revenueCodes||[]).map(row=>Number(row.round_id)));
      const roundsByShift=new Map<number,{gross:number;gifts:number;hasCode:boolean}>();
      for(const round of revenueRounds||[]){
        const shiftId=Number(round.shift_id); const current=roundsByShift.get(shiftId)||{gross:0,gifts:0,hasCode:false};
        if(codedRoundIds.has(Number(round.id))){
          const storedGross=Number(round.gross_amount||0);
          const soldQuantity=Number(round.sold_quantity||0);
          const ticketPrice=Number(round.ticket_price||0);
          // Dữ liệu nhập cũ có thể đã lưu số vé bán và giá vé nhưng gross_amount bằng 0.
          // Chỉ phục hồi doanh thu cho vòng thực sự có mã vé; không có mã vé vẫn bắt buộc tính 0.
          const effectiveGross=storedGross===0&&soldQuantity>0&&ticketPrice>0?soldQuantity*ticketPrice:storedGross;
          current.gross+=effectiveGross;current.gifts+=Number(round.gift_value||0);current.hasCode=true;
        }
        roundsByShift.set(shiftId,current);
      }
      const staffByShift=new Map<number,{cases:number;allowances:number}>();
      const staffIdsByShift=new Map<number,Set<number>>();
      for(const staff of revenueStaff||[]){
        const shiftId=Number(staff.shift_id);const current=staffByShift.get(shiftId)||{cases:0,allowances:0};
        current.cases+=Number(staff.case_amount||0);current.allowances+=Number(staff.allowance||0);staffByShift.set(shiftId,current);
        const ids=staffIdsByShift.get(shiftId)||new Set<number>();ids.add(Number(staff.employee_id));staffIdsByShift.set(shiftId,ids);
      }
      const draftByShift=new Map<number,{extraRoles:{organ:string;ticketChecker:string};caseMode:string}>();
      const extraEmployeeIds=new Set<number>();
      for(const draft of revenueDrafts||[]){
        const payload=draft.payload&&typeof draft.payload==="object"?draft.payload as Record<string,unknown>:{};
        const stored=draft.extra_roles&&typeof draft.extra_roles==="object"?draft.extra_roles as Record<string,unknown>:{};
        const payloadRoles=payload.extraRoles&&typeof payload.extraRoles==="object"?payload.extraRoles as Record<string,unknown>:{};
        const extraRoles={organ:String(stored.organ||payloadRoles.organ||""),ticketChecker:String(stored.ticketChecker||payloadRoles.ticketChecker||"")};
        draftByShift.set(Number(draft.shift_id),{extraRoles,caseMode:String(payload.caseMode||"regular")});
        for(const id of [Number(extraRoles.organ),Number(extraRoles.ticketChecker)])if(id>0)extraEmployeeIds.add(id);
      }
      const {data:extraEmployees,error:extraEmployeeError}=extraEmployeeIds.size
        ? await supabase.from("employees").select("id,weekday_case,weekend_case,holiday_case,tet_case,half_case,support_100k,support_200k").in("id",[...extraEmployeeIds])
        : {data:[],error:null};
      if(extraEmployeeError){setMessage(extraEmployeeError.message);setOverviewRevenueLoading(false);return;}
      const extraEmployeeById=new Map((extraEmployees||[]).map(employee=>[Number(employee.id),employee]));
      const extraCaseForShift=(shiftId:number)=>{
        const draft=draftByShift.get(shiftId);if(!draft)return 0;
        const existing=staffIdsByShift.get(shiftId)||new Set<number>();
        const uniqueIds=[...new Set([Number(draft.extraRoles.organ),Number(draft.extraRoles.ticketChecker)].filter(id=>id>0&&!existing.has(id)))];
        return uniqueIds.reduce((sum,id)=>{
          const employee=extraEmployeeById.get(id);if(!employee)return sum;
          const amount=draft.caseMode==="weekend"?employee.weekend_case:draft.caseMode==="holiday"?employee.holiday_case:draft.caseMode==="tet"?employee.tet_case:draft.caseMode==="half"?employee.half_case:draft.caseMode==="support100"?(Number(employee.support_100k)||100000):draft.caseMode==="support200"?(Number(employee.support_200k)||200000):employee.weekday_case;
          return sum+Number(amount||0);
        },0);
      };
      lotoRows=(revenueShifts||[]).flatMap(shift=>{
        const round=roundsByShift.get(Number(shift.id));
        if(!round?.hasCode)return[]; // File/phiên không có mã vé bắt buộc tính 0, không tạo doanh thu âm.
        const staff=staffByShift.get(Number(shift.id))||{cases:0,allowances:0};
        return[{entry_date:String(shift.performance_date),category:"loto",amount:round.gross-round.gifts-staff.cases-extraCaseForShift(Number(shift.id))-staff.allowances-Number(shift.kinh_trung_amount||0),venue_id:Number(shift.venue_id)}];
      });
    }
    let expenseQuery=supabase.from("finance_entries").select("entry_date,amount,venue_id").eq("business_id",businessId).eq("entry_type","expense").eq("status","approved").gte("entry_date",queryStart).lte("entry_date",date);
    if(targetVenue!==null) expenseQuery=expenseQuery.eq("venue_id",targetVenue);
    const {data:expenseData,error:expenseError}=await expenseQuery;
    if(expenseError){setMessage(expenseError.message);setOverviewRevenueLoading(false);return;}
    const categories=["loto","game","water","kiosk","other"];
    const snapshot=(startDate:string,endDate=startDate,venueScope:number|null=targetVenue):RevenueSnapshot=>{
      // Doanh thu Loto đã đồng bộ từ File Vé là số chốt chính thức cho ngày/sân khấu.
      // Tổng Quan không tự dựng lại một con số khác khi bản đồng bộ đã tồn tại.
      const manualLotoRows=(data||[]).filter(row=>{
        if(row.category!=="loto")return false;
        const normalizedNote=String(row.note||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/đ/g,"d").trim();
        return !normalizedNote.startsWith("tu dong");
      });
      const manualLotoKeys=new Set(manualLotoRows.map(row=>`${row.venue_id}|${row.entry_date}`));
      const syncedLotoRows=(data||[]).filter(row=>{
        if(row.category!=="loto")return false;
        const normalizedNote=String(row.note||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/đ/g,"d").trim();
        return normalizedNote.startsWith("tu dong: tien ve - case");
      });
      const syncedLotoKeys=new Set(syncedLotoRows.map(row=>`${row.venue_id}|${row.entry_date}`));
      // Loto source priority: synced Ticket File -> calculated Ticket File -> legacy manual fallback.
      const calculatedLotoKeys=new Set(lotoRows.map(row=>`${row.venue_id}|${row.entry_date}`));
      const effectiveLotoRows=[
        ...syncedLotoRows,
        ...lotoRows.filter(row=>!syncedLotoKeys.has(`${row.venue_id}|${row.entry_date}`)),
        ...manualLotoRows.filter(row=>!syncedLotoKeys.has(`${row.venue_id}|${row.entry_date}`)&&!calculatedLotoKeys.has(`${row.venue_id}|${row.entry_date}`))
      ];
      const rows=[...(data||[]).filter(row=>row.category!=="loto"),...effectiveLotoRows].filter(row=>row.entry_date>=startDate&&row.entry_date<=endDate&&(venueScope===null||row.venue_id===venueScope));
      const values=Object.fromEntries(categories.map(category=>[category,rows.filter(row=>row.category===category).reduce((sum,row)=>sum+Number(row.amount||0),0)]));
      return{total:Object.values(values).reduce((sum,value)=>sum+Number(value),0),categories:values};
    };
    const expenseTotal=(startDate:string,endDate=startDate,venueScope:number|null=targetVenue)=>(expenseData||[]).filter(row=>row.entry_date>=startDate&&row.entry_date<=endDate&&(venueScope===null||row.venue_id===venueScope)).reduce((sum,row)=>sum+Number(row.amount||0),0);
    const netSnapshot=(startDate:string,endDate=startDate,venueScope:number|null=targetVenue):RevenueSnapshot=>{
      const gross=snapshot(startDate,endDate,venueScope);
      return{...gross,total:gross.total-expenseTotal(startDate,endDate,venueScope)};
    };
    setOverviewRevenue({date,yesterdayDate,previousWeekDate,weekStart:currentWeekStart,weekEnd:date,monthStart:currentMonthStart,current:netSnapshot(date),currentWeek:netSnapshot(currentWeekStart,date),currentMonth:netSnapshot(currentMonthStart,date),yesterday:netSnapshot(yesterdayDate),previousWeek:netSnapshot(previousWeekStart,previousWeekEnd)});
    if(targetVenue===null)setOverviewVenueRevenue(venues.map(venue=>({venue_id:venue.id,day_total:netSnapshot(date,date,venue.id).total,week_total:netSnapshot(currentWeekStart,date,venue.id).total,day_expense:expenseTotal(date,date,venue.id),week_expense:expenseTotal(currentWeekStart,date,venue.id)})));else setOverviewVenueRevenue([]);
    setOverviewRevenueLoading(false);
  }

  const currentPosition=()=>new Promise<GeolocationPosition>((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000,maximumAge:0}));
  async function invokeAttendance(body:Record<string,unknown>){
    const {data,error}=await supabase.functions.invoke("attendance-control",{body});
    if(error)throw new Error((data as {error?:string}|null)?.error||error.message);
    if(data?.error)throw new Error(data.error);
    return data;
  }
  async function loadAttendanceStatus(){
    if(!session)return;
    try{const data=await invokeAttendance({action:"status"});setAttendanceSession(data.session||null);setAttendanceEmployee(data.employee||null);}catch(error){setMessage(error instanceof Error?error.message:"Không tải được trạng thái chấm công.");}
  }
  async function configureAttendanceSite(){
    if(!attendanceVenueId)return;
    setAttendanceLoading(true);setMessage("Đang lấy GPS và nhận diện Wi-Fi hiện tại…");
    try{const position=await currentPosition();const data=await invokeAttendance({action:"configure_site",venue_id:Number(attendanceVenueId),latitude:position.coords.latitude,longitude:position.coords.longitude,radius_m:Number(attendanceRadius)||100});setMessage(data.message);await loadWorkspace();}
    catch(error){setMessage(error instanceof Error?error.message:"Không thể cấu hình địa điểm.");}finally{setAttendanceLoading(false);}
  }
  async function saveAttendanceEmployee(employee:Employee){
    setAttendanceLoading(true);
    try{
      const data=await invokeAttendance({action:"update_employee_config",employee_id:employee.id,department:employee.department||null,pay_type:employee.pay_type||null,monthly_salary:Number(employee.monthly_salary)||0,hourly_rate:Number(employee.hourly_rate)||0,weekly_hourly_rate:Number(employee.weekly_hourly_rate)||0,daily_rate:Number(employee.daily_rate)||0,attendance_enabled:Boolean(employee.attendance_enabled)});
      const {error:updateError}=await supabase.from("employees").update({weekly_hourly_rate:Number(employee.weekly_hourly_rate)||0,daily_rate:Number(employee.daily_rate)||0}).eq("id",employee.id).eq("business_id",profile?.business_id);
      if(updateError)throw updateError;
      setMessage(data.message);
    }
    catch(error){setMessage(error instanceof Error?error.message:"Không thể lưu cấu hình nhân sự.");}finally{setAttendanceLoading(false);}
  }
  async function saveEmployeeScheduleClassification(employee:Employee){
    if(!profile||(profile.role!=="owner"&&profile.role!=="manager"))return;
    setSaving(true);
    const {error}=await supabase.from("employees").update({scheduling_level:employee.scheduling_level||"C",scheduling_symbol:(employee.scheduling_symbol||employee.scheduling_level||"C").trim().slice(0,8),scheduling_note:(employee.scheduling_note||"").trim()||null}).eq("id",employee.id).eq("business_id",profile.business_id);
    setSaving(false);
    setMessage(error?error.message:`Đã lưu phân cấp xếp lịch cho ${employee.full_name}.`);
  }
  async function attendanceAction(action:"check_in"|"check_out"|"heartbeat"){
    setAttendanceLoading(action!=="heartbeat");
    try{let location:Record<string,number>={};if(action==="check_in"){const position=await currentPosition();location={latitude:position.coords.latitude,longitude:position.coords.longitude};}const data=await invokeAttendance({action,venue_id:Number(attendanceVenueId),...location});if(data.session)setAttendanceSession(data.session);if(data.message)setMessage(data.message);}
    catch(error){if(action!=="heartbeat")setMessage(error instanceof Error?error.message:"Không thể chấm công.");}finally{if(action!=="heartbeat")setAttendanceLoading(false);}
  }

  useEffect(()=>{if(session&&profile?.employee_id&&panel==="staffManagement"&&personnelTab==="attendance")void loadAttendanceStatus();},[session,profile?.employee_id,panel,personnelTab]);
  useEffect(()=>{if(!session||!attendanceSession||attendanceSession.status!=="active")return;const timer=window.setInterval(()=>void attendanceAction("heartbeat"),60000);return()=>window.clearInterval(timer);},[session,attendanceSession?.id,attendanceSession?.status]);

  useEffect(()=>{
    if(!session||!activeShift||panel!=="overview")return;
    const selectedVenue=overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):null;
    void loadOverviewRevenue(activeShift,selectedVenue,overviewRevenueDate);
  },[session,activeShift?.id,activeShift?.performance_date,panel,overviewRevenueSelection,overviewRevenueDate]);
  useEffect(()=>{if(session&&profile&&(profile.role==="owner"||profile.role==="manager")&&panel==="overview"){void loadOverviewTicketVariances();void loadOverviewTicketStocks();}},[session,profile?.business_id,profile?.role,profile?.venue_id,panel,venues.length]);
  useEffect(()=>{
    const selectedVenue=overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):0;
    const selectedName=venues.find(venue=>venue.id===selectedVenue)?.name.toLowerCase()||"";
    if(selectedVenue&&selectedName.includes("go an lac")&&overviewRevenueDate)void loadGoAnLacNightRewards(selectedVenue,overviewRevenueDate);
    else setGoAnLacResponsibleIds(["","",""]);
  },[profile?.business_id,overviewRevenueSelection,overviewRevenueDate,venues.length]);
  useEffect(()=>{
    if(!session||!profile||(profile.role!=="owner"&&profile.role!=="manager")||panel!=="overview")return;
    const refresh=()=>{if(document.visibilityState==="visible"){void loadOverviewTicketVariances();void loadOverviewTicketStocks();}};
    const timer=window.setInterval(refresh,60000);
    document.addEventListener("visibilitychange",refresh);
    return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};
  },[session?.user.id,profile?.business_id,profile?.role,profile?.venue_id,panel,venues.length]);
  useEffect(()=>{
    if(!session||panel!=="tickets"||!activeShift){setShiftTicketStockAlert(null);return;}
    void loadShiftTicketStockAlert(activeShift);
    const refresh=()=>{if(document.visibilityState==="visible")void loadShiftTicketStockAlert(activeShift);};
    const timer=window.setInterval(refresh,60000);
    document.addEventListener("visibilitychange",refresh);
    return()=>{window.clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};
  },[session?.user.id,panel,activeShift?.id,activeShift?.venue_id]);

  useEffect(() => {
    if (!session || !profile || (profile.role !== "owner" && profile.role !== "manager") || (panel !== "overview" && panel !== "approvals")) return;
    const timer = window.setInterval(() => { if(document.visibilityState==="visible")void loadApprovals(); }, 45000);
    return () => window.clearInterval(timer);
  }, [session, profile, activeShift, panel]);

  useEffect(()=>{
    if(!session||!profile||!openVenueShifts.length)return;
    const timer=window.setInterval(async()=>{
      const now=Date.now();
      const expired=openVenueShifts.filter(shift=>now-new Date(shift.opened_at).getTime()>12*60*60*1000);
      if(!expired.length)return;
      const results=await Promise.all(expired.map(async shift=>({shift,error:(await supabase.rpc("close_ticket_shift",{p_shift_id:shift.id})).error})));
      const closedIds=new Set(results.filter(result=>!result.error).map(result=>result.shift.id));
      if(!closedIds.size)return;
      setOpenVenueShifts(current=>current.filter(shift=>!closedIds.has(shift.id)));
      if(activeShift&&closedIds.has(activeShift.id)){
        rememberTicketShift(null);
        if(panel==="tickets")setPanel("overview");
        setMessage("Ca đã tự động kết thúc vì thời gian từ lúc mở ca đã vượt quá 12 giờ.");
      }
    },60000);
    return()=>window.clearInterval(timer);
  },[session,profile?.business_id,openVenueShifts,activeShift?.id,panel]);

  useEffect(() => {
    if (!session || !activeShift) return;
    const selectedVenue=overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):activeShift.venue_id;
    const channel = supabase
      .channel(`finance-venue-${selectedVenue}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "finance_entries",
        filter: `venue_id=eq.${selectedVenue}`,
      }, () => {
        if (panel === "finance") void loadFinance(financeDate,financePeriod);
        if (panel === "overview") void loadOverviewRevenue(activeShift,overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):null,overviewRevenueDate);
        if (profile?.role === "owner" || profile?.role === "manager") void loadApprovals();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [session, activeShift?.venue_id, panel, financeDate, financePeriod, profile?.role, overviewRevenueSelection, overviewRevenueDate, supabase]);

  useEffect(() => {
    if (!session || !activeShift) return;
    const watchedShiftId=activeShift.id;
    const shiftSnapshot=(shift:Partial<Shift>)=>[
      shift.id,shift.name,shift.venue_id,shift.opened_at,shift.opened_by,
      shift.closed_by,shift.closed_at,shift.performance_date,
      shift.kinh_trung_amount,shift.status,
    ].map(value=>String(value??"")).join("|");
    const applyShiftLockUpdate=(updated:Shift)=>{
      if(updated.id!==watchedShiftId)return;
      setActiveShift(current=>{
        if(current?.id!==watchedShiftId)return current;
        const merged={...current,...updated};
        return shiftSnapshot(current)===shiftSnapshot(merged)?current:merged;
      });
      setOpenVenueShifts(current=>{
        if(updated.status==="closed"){
          return current.some(shift=>shift.id===watchedShiftId)
            ? current.filter(shift=>shift.id!==watchedShiftId)
            : current;
        }
        let changed=false;
        const next=current.map(shift=>{
          if(shift.id!==watchedShiftId)return shift;
          const merged={...shift,...updated};
          if(shiftSnapshot(shift)===shiftSnapshot(merged))return shift;
          changed=true;
          return merged;
        });
        return changed?next:current;
      });
      if(updated.status==="closed"){
        setHistoryMode(false);
        setEditingShiftStaff(false);
        setMessage(activeShift.opened_by===session.user.id&&updated.closed_by!==session.user.id
          ? "Chủ sở hữu đã đóng ca này. Tài khoản của bạn đã mất quyền chỉnh sửa File Vé."
          : "Ca đã được đóng. File Vé hiện chuyển sang chế độ chỉ đọc.");
      }
    };
    const channel=supabase
      .channel(`ticket-shift-lock-${watchedShiftId}-${session.user.id}`)
      .on("postgres_changes",{event:"UPDATE",schema:"public",table:"shifts",filter:`id=eq.${watchedShiftId}`},payload=>{
        applyShiftLockUpdate(payload.new as Shift);
      })
      .subscribe();
    const verifyTimer=window.setInterval(async()=>{
      const {data}=await supabase.from("shifts")
        .select("id,name,venue_id,opened_at,opened_by,closed_by,closed_at,performance_date,kinh_trung_amount,status")
        .eq("id",watchedShiftId).maybeSingle();
      if(data)applyShiftLockUpdate(data as Shift);
    },10000);
    return()=>{window.clearInterval(verifyTimer);void supabase.removeChannel(channel);};
  },[session?.user.id,activeShift?.id,supabase]);

  useEffect(() => {
    if (!session || !activeShift || panel!=="tickets") return;
    const watchedShiftId=activeShift.id;
    const watchedVenueId=activeShift.venue_id;
    const applyRemoteDraft=(record:any,force=false)=>{
      if(Number(record?.shift_id)!==watchedShiftId||Number(record?.venue_id)!==watchedVenueId)return;
      const payload=record?.payload as Partial<TicketShiftDraft>|undefined;
      if(!payload||!Array.isArray(payload.rows))return;
      if(payload.clientId&&payload.clientId===ticketDraftClientId())return;
      const updatedAt=String(record?.updated_at||"");
      if(updatedAt&&updatedAt<=ticketLastServerDraftAtRef.current)return;
      if(!force&&(ticketLocalDirtyRef.current||Date.now()<ticketLocalEditUntilRef.current)){
        ticketPendingRemoteDraftRef.current=record;
        return;
      }
      const persistedExtraRoles=record?.extra_roles&&typeof record.extra_roles==="object"
        ? {organ:String(record.extra_roles.organ||""),ticketChecker:String(record.extra_roles.ticketChecker||"")}
        : null;
      const rows=payload.rows.filter((row:any)=>row&&typeof row.id==="string"&&Array.isArray(row.codes)).map((row:any)=>({
        id:row.id,
        codes:[0,1,2,3].map(index=>String(row.codes[index]||"")),
        quantities:row.quantities&&typeof row.quantities==="object"?row.quantities:{},
        price:Number(row.price||10000),
        gift:String(row.gift||""),
        ...(row.promotionRole?{promotionRole:row.promotionRole}:{}),
        ...(row.promotionGroupId?{promotionGroupId:row.promotionGroupId}:{}),
        ...(normalizeTicketRowColor(row.rowColor)?{rowColor:normalizeTicketRowColor(row.rowColor)}:{}),
      })) as TicketRow[];
      ticketSkipDraftPersistRef.current=true;
      ticketLocalDirtyRef.current=false;
      ticketLastServerDraftAtRef.current=updatedAt;
      setTicketRows(rows.length?rows:Array.from({length:12},blankTicketRow));
      if(payload.allowances&&typeof payload.allowances==="object")setAllowances(payload.allowances);
      if(typeof payload.kinhTrung==="string")setKinhTrung(payload.kinhTrung);
      if(persistedExtraRoles&&(persistedExtraRoles.organ||persistedExtraRoles.ticketChecker))setTicketExtraRoles(persistedExtraRoles);
      else if(payload.extraRoles&&typeof payload.extraRoles==="object")setTicketExtraRoles({organ:String(payload.extraRoles.organ||""),ticketChecker:String(payload.extraRoles.ticketChecker||"")});
      if(payload.caseMode)setCaseMode(payload.caseMode);
      setTicketDraftSavedAt(updatedAt);
      setTicketDraftStatus("saved");
    };
    const applyPendingRemoteDraft=()=>{
      const pending=ticketPendingRemoteDraftRef.current;
      if(!pending||ticketLocalDirtyRef.current||Date.now()<ticketLocalEditUntilRef.current)return;
      ticketPendingRemoteDraftRef.current=null;
      applyRemoteDraft(pending,true);
    };
    const pullLatest=async()=>{
      const {data}=await supabase.from("ticket_shift_drafts")
        .select("shift_id,venue_id,payload,extra_roles,updated_by,updated_at")
        .eq("shift_id",watchedShiftId).eq("venue_id",watchedVenueId).maybeSingle();
      if(data)applyRemoteDraft(data);
    };
    const channel=supabase
      .channel(`ticket-live-view-${watchedShiftId}-${ticketDraftClientId()}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"ticket_shift_drafts",filter:`shift_id=eq.${watchedShiftId}`},payload=>applyRemoteDraft(payload.new))
      .subscribe();
    void pullLatest();
    const pendingTimer=window.setInterval(applyPendingRemoteDraft,1500);
    const fallbackTimer=window.setInterval(()=>{
      applyPendingRemoteDraft();
      const activeElement=document.activeElement;
      const isEditing=activeElement instanceof HTMLInputElement||activeElement instanceof HTMLSelectElement||activeElement instanceof HTMLTextAreaElement;
      if(document.visibilityState==='visible'&&!isEditing&&!ticketLocalDirtyRef.current)void pullLatest();
    },30000);
    return()=>{window.clearInterval(pendingTimer);window.clearInterval(fallbackTimer);ticketPendingRemoteDraftRef.current=null;void supabase.removeChannel(channel);};
  },[session?.user.id,activeShift?.id,activeShift?.venue_id,panel,supabase]);
  useEffect(()=>{if(session&&profile&&panel==="staffManagement"&&personnelTab==="competition")void loadStaffCompetition(scoreMonth);},[session,profile,panel,personnelTab,scoreMonth]);
  useEffect(()=>{if(!session||!profile||panel!=="staffManagement")return;if(personnelTab==="off")void loadTimeOffRequests();if(personnelTab==="schedule")void Promise.all([loadTimeOffRequests(),loadWeeklySchedules()]);if(personnelTab==="mySchedule")void loadMySchedule();if(personnelTab==="payroll")void loadSalaryAdvances();},[session,profile,panel,personnelTab]);

  async function saveCompanyEmployee(employee:Employee){
    if(!profile||!(profile.role==="owner"||profile.role==="manager"))return;
    setHrSaving(true);
    const isLoto=employee.department==="loto";
    const bonusAdvanceEligible=Number(employee.bonus_amount||0)>=5000000;
    const {error}=await supabase.from("employees").update({full_name:employee.full_name.trim(),joined_on:employee.joined_on||null,department:employee.department||null,loto_role:isLoto?employee.loto_role||null:null,pay_type:isLoto?null:employee.pay_type||null,monthly_salary:isLoto?0:Number(employee.monthly_salary)||0,hourly_rate:isLoto?0:Number(employee.hourly_rate)||0,daily_rate:isLoto?0:Number(employee.daily_rate)||0,weekly_hourly_rate:isLoto?0:Number(employee.weekly_hourly_rate)||0,weekly_salary:isLoto?0:Number(employee.weekly_salary)||0,weekend_hourly_rate:isLoto?0:Number(employee.weekend_hourly_rate)||0,holiday_hourly_rate:isLoto?0:Number(employee.holiday_hourly_rate)||0,daily_weekend_rate:isLoto?0:Number(employee.daily_weekend_rate)||0,daily_holiday_rate:isLoto?0:Number(employee.daily_holiday_rate)||0,weekday_case:Number(employee.weekday_case)||0,weekend_case:Number(employee.weekend_case)||0,payroll_closing_day:Number(employee.payroll_closing_day)||31,salary_payment_day:Number(employee.salary_payment_day)||10,weekly_payment_weekday:employee.pay_type==="weekly"?3:(Number(employee.weekly_payment_weekday)||3),responsibility_amount:Number(employee.responsibility_amount)||0,bonus_amount:Number(employee.bonus_amount)||0,bonus_advance_eligible:bonusAdvanceEligible,bonus_advance_limit:bonusAdvanceEligible?3000000:0,job_title:employee.job_title?.trim()||null,account_access_level:Number(employee.account_access_level)||3,account_venue_id:employee.account_venue_id||null}).eq("id",employee.id).eq("business_id",profile.business_id);
    setHrSaving(false);if(!error)setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,bonus_advance_eligible:bonusAdvanceEligible,bonus_advance_limit:bonusAdvanceEligible?3000000:0}:row));setMessage(error?error.message:"Đã lưu hồ sơ nhân sự công ty.");
  }

  async function addCompanyEmployee(){
    if(!profile||!(profile.role==="owner"||profile.role==="manager"))return;
    const fullName=newEmployeeProfile.full_name.trim();
    if(!fullName||!newEmployeeProfile.department){setMessage("Vui lòng nhập họ tên và chọn bộ phận.");return;}
    const managerVenueId=profile.role==="manager"?Number(profile.venue_id||0):0;
    const accountVenueId=managerVenueId||Number(newEmployeeProfile.account_venue_id||0);
    if(profile.role==="manager"&&!accountVenueId){setMessage("Tài khoản quản lý chưa được gắn sân khấu phụ trách.");return;}
    const salary=Number(newEmployeeProfile.salary.replace(/\D/g,""))||0;
    const weekendSalary=Number(newEmployeeProfile.weekend_salary.replace(/\D/g,""))||0;
    const holidaySalary=Number(newEmployeeProfile.holiday_salary.replace(/\D/g,""))||0;
    const bonusAmount=Number(newEmployeeProfile.bonus_amount.replace(/\D/g,""))||0;
    const payType=newEmployeeProfile.department==="loto"?null:newEmployeeProfile.pay_type||null;
    setHrSaving(true);
    const {data,error}=await supabase.from("employees").insert({business_id:profile.business_id,full_name:fullName,department:newEmployeeProfile.department,joined_on:newEmployeeProfile.joined_on||null,job_title:newEmployeeProfile.job_title.trim()||null,pay_type:payType,monthly_salary:payType==="monthly"?salary:0,weekly_hourly_rate:0,weekly_salary:payType==="weekly"?salary:0,weekend_hourly_rate:payType==="hourly"?weekendSalary:0,holiday_hourly_rate:payType==="hourly"?holidaySalary:0,daily_weekend_rate:payType==="daily"?weekendSalary:0,daily_holiday_rate:payType==="daily"?holidaySalary:0,weekly_payment_weekday:3,daily_rate:payType==="daily"?salary:0,hourly_rate:payType==="hourly"?salary:0,weekday_case:newEmployeeProfile.department==="loto"?(Number(newEmployeeProfile.weekday_case.replace(/\D/g,""))||0):0,weekend_case:newEmployeeProfile.department==="loto"?(Number(newEmployeeProfile.weekend_case.replace(/\D/g,""))||0):0,payroll_closing_day:31,salary_payment_day:10,responsibility_amount:0,bonus_amount:bonusAmount,bonus_advance_eligible:false,bonus_advance_limit:0,account_access_level:Number(newEmployeeProfile.account_access_level)||3,account_venue_id:accountVenueId||null}).select("*").single();
    setHrSaving(false);
    if(error){setMessage(error.message);return;}
    const created=data as Employee;
    setEmployees(rows=>[...rows,created].sort((a,b)=>a.full_name.localeCompare(b.full_name,"vi")));
    setHrEmployeeId(String(created.id));
    setAddingEmployee(false);
    setNewEmployeeProfile({full_name:"",department:"",joined_on:localDateValue(),job_title:"",pay_type:"",salary:"",weekend_salary:"",holiday_salary:"",weekly_payment_weekday:3,bonus_amount:"",weekday_case:"",weekend_case:"",account_access_level:3,account_venue_id:""});
    setMessage(`Đã thêm hồ sơ ${created.full_name}${profile.role==="manager"?" vào đúng sân khấu quản lý":""}.`);
  }

  const employeeUsername=(name:string)=>name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/Đ/g,"D").replace(/đ/g,"d").trim().replace(/[^A-Za-z0-9]+/g,"_").replace(/^_+|_+$/g,"").toUpperCase();
  async function createEmployeeAccount(employee:Employee){
    if(!session||profile?.role!=="owner")return;
    const isMyTien=employee.full_name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim()==="MY TIEN";
    const targetRole=isMyTien?"owner":(employee.account_access_level===1?"manager":"employee");
    const targetVenue=targetRole==="manager"?employee.account_venue_id:null;
    if(targetRole==="manager"&&!targetVenue){setMessage("Tài khoản quản lý bắt buộc phải chọn đúng sân khấu phụ trách.");return;}
    setHrSaving(true);const username=employeeUsername(employee.full_name);const {data,error}=await supabase.functions.invoke("manage-internal-users",{body:{username,password:"123456789",full_name:employee.full_name,role:targetRole,access_level:isMyTien?1:(employee.account_access_level||3),venue_id:targetVenue,employee_id:employee.id}});
    if(!error&&!data?.error)await supabase.from("profiles").update({must_change_password:true}).eq("employee_id",employee.id).eq("business_id",profile.business_id);
    setHrSaving(false);setMessage(error||data?.error?(data?.error||error?.message):`Đã tạo tài khoản ${username}. Mật khẩu tạm: 123456789`);
  }

  async function deactivateEmployee(employee:Employee){
    if(!session||profile?.role!=="owner")return;
    const confirmed=window.confirm(`Ngưng hoạt động nhân sự ${employee.full_name}?\n\nNhân sự sẽ bị khóa toàn bộ chức năng và không thể đăng nhập hệ thống. Lịch sử dữ liệu vẫn được giữ nguyên.`);
    if(!confirmed)return;
    setHrSaving(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-internal-users",{body:{action:"deactivate_employee",employee_id:employee.id}});
    setHrSaving(false);
    if(error||data?.error){setMessage(data?.error||error?.message||"Không thể ngưng hoạt động nhân sự.");return;}
    setEmployees(rows=>rows.filter(row=>row.id!==employee.id));
    setHrEmployeeId(current=>current===String(employee.id)?"":current);
    setMessage(`Đã ngưng hoạt động ${employee.full_name}. Tài khoản liên kết đã bị khóa đăng nhập.`);
  }

  async function changeFirstPassword(){
    if(firstPassword.length<8||firstPassword!==firstPasswordConfirm){setMessage("Mật khẩu mới phải từ 8 ký tự và hai ô phải giống nhau.");return;}
    setHrSaving(true);const {error}=await supabase.auth.updateUser({password:firstPassword});if(error){setHrSaving(false);setMessage(error.message);return;}
    const {error:flagError}=await supabase.rpc("complete_first_login_password_change");setHrSaving(false);if(flagError){setMessage(flagError.message);return;}setFirstPassword("");setFirstPasswordConfirm("");setProfile(current=>current?{...current,must_change_password:false}:current);setMessage("Đã đổi mật khẩu. Bạn có thể sử dụng hệ thống.");
  }

  async function loadSalaryAdvances(monthValue?:string){
    if(!profile)return;
    const month=(monthValue||localDateValue()).slice(0,7)+"-01";
    let query=supabase.from("salary_advance_requests").select("id,employee_id,venue_id,request_month,request_type,installment,amount,note,status,created_at,employee:employees(full_name)").eq("business_id",profile.business_id).eq("request_month",month).order("created_at",{ascending:false});
    if(profile.role==="manager"&&profile.venue_id)query=query.eq("venue_id",profile.venue_id);
    else if(profile.role!=="owner"&&profile.employee_id)query=query.eq("employee_id",profile.employee_id);
    const {data,error}=await query;if(error)setMessage(error.message);else setSalaryAdvances((data||[]) as unknown as SalaryAdvance[]);
    const monthEnd=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
    let paymentQuery=supabase.from("finance_entries").select("amount,note,venue_id").eq("business_id",profile.business_id).eq("entry_type","expense").eq("category","payroll").eq("status","approved").gte("entry_date",month).lte("entry_date",monthEnd);
    if(profile.role==="manager"&&profile.venue_id)paymentQuery=paymentQuery.eq("venue_id",profile.venue_id);
    const {data:paymentRows,error:paymentError}=await paymentQuery;
    if(paymentError){setMessage(paymentError.message);return;}
    setApprovedPayrollPayments((paymentRows||[]).reduce((totals:Record<number,number>,row:any)=>{
      const employeeId=Number(String(row.note||"").match(/\[EMPLOYEE:(\d+)\]/)?.[1]||0);
      if(employeeId)totals[employeeId]=(totals[employeeId]||0)+Number(row.amount||0);
      return totals;
    },{}));
  }

  async function requestSalaryAdvance(){
    if(!profile||!session||!advanceAmount)return;
    const canProposeForStaff=profile.role==="owner"||profile.role==="manager";
    const targetEmployeeId=canProposeForStaff?Number(advanceEmployeeId||profile.employee_id):Number(profile.employee_id);
    if(!targetEmployeeId){setMessage("Chưa chọn nhân sự cần đề xuất ứng lương.");return;}
    const employee=employees.find(item=>item.id===targetEmployeeId);
    if(!employee){setMessage("Không tìm thấy hồ sơ nhân sự.");return;}
    if(profile.role==="manager"&&(!profile.venue_id||employee.account_venue_id!==profile.venue_id)){setMessage("Quản lý chỉ được đề xuất ứng lương cho nhân sự thuộc đúng sân khấu mình phụ trách.");return;}
    if(!employee.account_venue_id){setMessage("Nhân sự chưa được cấu hình sân khấu trong Hồ Sơ & Lương.");return;}
    const amount=Number(advanceAmount.replace(/\D/g,""));
    if(amount<=0){setMessage("Số tiền ứng phải lớn hơn 0.");return;}
    const activeRequests=salaryAdvances.filter(item=>item.employee_id===targetEmployeeId&&item.status!=="rejected");
    if(activeRequests.some(item=>item.request_type===advanceType&&item.installment===Number(advanceInstallment))){setMessage(`Nhân sự này đã có đề xuất ${advanceType==="bonus"?"ứng thưởng":"ứng lương"} đợt ${advanceInstallment} trong tháng.`);return;}
    if(advanceType==="salary"){
      const salaryRequests=activeRequests.filter(item=>item.request_type==="salary");
      if(salaryRequests.length>=2){setMessage("Mỗi nhân sự chỉ được ứng lương tối đa 2 lần trong một tháng.");return;}
      const salaryBase=employee.pay_type==="monthly"?Number(employee.monthly_salary||0):employee.pay_type==="weekly"?Number(employee.weekly_salary||0):employee.pay_type==="daily"?Number(employee.daily_rate||0):Number(employee.hourly_rate||0);
      const alreadyRequested=salaryRequests.reduce((sum,item)=>sum+Number(item.amount||0),0);
      if(salaryBase>0&&alreadyRequested+amount>salaryBase){setMessage(`Tổng tiền ứng không được vượt mức lương ${salaryBase.toLocaleString("vi-VN")} đ.`);return;}
    }
    if(advanceType==="bonus"){
      const limit=Math.min(3000000,Number(employee.bonus_advance_limit||3000000));
      const alreadyRequested=activeRequests.filter(item=>item.request_type==="bonus").reduce((sum,item)=>sum+Number(item.amount||0),0);
      if(!employee.bonus_advance_eligible||Number(employee.bonus_amount||0)<5000000||alreadyRequested+amount>limit){setMessage(`Chỉ nhân sự phụ trách có thưởng 5.000.000 đ mới được ứng thưởng; tổng mức ứng tối đa ${limit.toLocaleString("vi-VN")} đ/tháng.`);return;}
    }
    setHrSaving(true);const {error}=await supabase.from("salary_advance_requests").insert({business_id:profile.business_id,employee_id:targetEmployeeId,venue_id:employee.account_venue_id,request_month:localDateValue().slice(0,7)+"-01",request_type:advanceType,installment:Number(advanceInstallment),amount,requested_by:session.user.id});setHrSaving(false);
    if(error)setMessage(error.code==="23505"?"Bạn đã đăng ký đợt ứng này trong tháng.":error.message);else{setAdvanceAmount("");setMessage("Đã gửi đăng ký ứng lương để chờ duyệt.");await loadSalaryAdvances();}
  }

  async function reviewSalaryAdvance(item:SalaryAdvance,decision:"approved"|"rejected"){
    if(profile?.role!=="owner"||!session)return;setHrSaving(true);
    if(decision==="rejected"){
      const reason=prompt("Nhập lý do không duyệt để người đề xuất nắm:",rejectionReasonFromNote(item.note));
      if(reason===null){setHrSaving(false);return;}
      if(!reason.trim()){setHrSaving(false);setMessage("Bắt buộc nhập lý do khi không duyệt.");return;}
      const {error}=await supabase.from("salary_advance_requests").update({status:"rejected",note:noteWithRejectionReason(item.note,reason),reviewed_by:session.user.id,reviewed_at:new Date().toISOString()}).eq("id",item.id);setHrSaving(false);if(error)setMessage(error.message);else{setMessage("Đã từ chối đăng ký ứng lương và lưu lý do.");await Promise.all([loadSalaryAdvances(),loadApprovals(),loadRegistrationTracking()]);}return;
    }
    const clientId=`salary-advance-${item.id}`;
    const {data:entry,error:entryError}=await supabase.from("finance_entries").upsert({client_id:clientId,business_id:profile.business_id,venue_id:item.venue_id,entry_date:localDateValue(),entry_type:"expense",category:"payroll",amount:item.amount,note:`Ứng lương đợt ${item.installment} - ${item.employee?.full_name||"Nhân sự"}`,status:"pending",created_by:session.user.id},{onConflict:"client_id"}).select("id").single();
    if(entryError){setHrSaving(false);setMessage(entryError.message);return;}
    const {error}=await supabase.from("salary_advance_requests").update({status:"sent_to_expense",reviewed_by:session.user.id,reviewed_at:new Date().toISOString(),finance_entry_id:entry.id}).eq("id",item.id);
    setHrSaving(false);if(error)setMessage(error.message);else{setMessage("Đã duyệt ứng lương và chuyển sang danh sách Chi chờ quản lý khu chi tiền.");await Promise.all([loadSalaryAdvances(),loadApprovals(),loadRegistrationTracking()]);}
  }

  async function loadMySchedule(selectedEmployeeId?:number){
    if(!profile)return;
    const canInspectAll=profile.role==="owner"||profile.role==="manager";
    const targetEmployeeId=canInspectAll?(selectedEmployeeId||Number(myScheduleEmployeeId)||lotoEmployees[0]?.id):(profile.employee_id||null);
    if(!targetEmployeeId){setMySchedules([]);return;}
    if(canInspectAll&&!lotoEmployees.some(employee=>employee.id===targetEmployeeId)){setMySchedules([]);setMessage("Lịch Của Tôi chỉ hiển thị nhân sự thuộc bộ phận Loto.");return;}
    if(canInspectAll)setMyScheduleEmployeeId(String(targetEmployeeId));
    const current=currentWeekDays(),next=nextWeekDays();
    setWeeklyScheduleLoading(true);
    const {data,error}=await supabase.from("weekly_staff_schedules")
      .select("id,venue_id,employee_id,work_date,week_start,venue:venues(name)")
      .eq("business_id",profile.business_id)
      .eq("employee_id",targetEmployeeId)
      .gte("work_date",current[0].date)
      .lte("work_date",next[6].date)
      .order("work_date");
    setWeeklyScheduleLoading(false);
    if(error){setMessage(error.message);return;}
    setMySchedules((data||[]) as unknown as WeeklyStaffSchedule[]);
  }

  async function loadTimeOffRequests(selectedEmployeeId?:number){
    if(!profile)return;
    const days=nextWeekDays();
    const targetEmployeeId=profile.employee_id||selectedEmployeeId||Number(timeOffEmployeeId)||employees[0]?.id||0;
    if(profile.role==="owner"&&targetEmployeeId)setTimeOffEmployeeId(String(targetEmployeeId));
    setTimeOffLoading(true);
    const {data,error}=await supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at,employee:employees(full_name)").eq("business_id",profile.business_id).eq("week_start",days[0].date).order("off_date");
    setTimeOffLoading(false);
    if(error){setMessage(error.message);return;}
    const rows=(data||[]) as unknown as TimeOffRequest[];
    setTimeOffRequests(rows);
    setSelectedOffDates(rows.filter(row=>row.employee_id===targetEmployeeId&&row.status!=="rejected").map(row=>row.off_date));
  }

  function toggleOffDate(date:string){
    setSelectedOffDates(current=>current.includes(date)?current.filter(item=>item!==date):[...current,date]);
  }

  async function saveTimeOffRequests(){
    const targetEmployeeId=profile?.employee_id||Number(timeOffEmployeeId);
    if(!profile||!targetEmployeeId||!session)return;
    if(!timeOffRegistrationWindow().open){setMessage("Đăng ký lịch Off đã khóa. Cổng đăng ký mở từ 00:01 Thứ Bảy đến 12:00 Chủ Nhật.");return;}
    const days=nextWeekDays();
    const ownRows=timeOffRequests.filter(row=>row.employee_id===targetEmployeeId);
    const desired=new Set(selectedOffDates);
    setTimeOffLoading(true);
    const removableRows=ownRows.filter(row=>!desired.has(row.off_date)||row.status==="rejected");
    const removable=removableRows.map(row=>row.id);
    if(removable.length){const {error}=await supabase.from("staff_time_off_requests").delete().in("id",removable);if(error){setTimeOffLoading(false);setMessage(error.message);return;}}
    const removedIds=new Set(removable);
    const existingDates=new Set(ownRows.filter(row=>!removedIds.has(row.id)).map(row=>row.off_date));
    const inserts=[...desired].filter(date=>!existingDates.has(date)).map(off_date=>({business_id:profile.business_id,employee_id:targetEmployeeId,off_date,week_start:days[0].date,status:"pending",note:null,created_by:session.user.id}));
    if(inserts.length){const {error}=await supabase.from("staff_time_off_requests").insert(inserts);if(error){setTimeOffLoading(false);setMessage(error.message);return;}}
    setTimeOffLoading(false);setMessage(inserts.some(item=>timeOffNeedsApproval(item.off_date,item.note))?"Đã lưu. Off Thứ Bảy, Chủ Nhật hoặc ngày lễ đã được gửi duyệt.":"Đã lưu lịch Off Thứ Hai–Thứ Sáu, không cần duyệt.");await loadTimeOffRequests();
  }

  async function requestEmergencyOffToday(){
    const targetEmployeeId=profile?.employee_id||Number(timeOffEmployeeId);
    if(!profile||!targetEmployeeId||!session)return;
    const today=localDateValue(),weekStart=currentWeekDays()[0].date;
    setTimeOffLoading(true);
    const {data:existing,error:checkError}=await supabase.from("staff_time_off_requests").select("id,status,note").eq("business_id",profile.business_id).eq("employee_id",targetEmployeeId).eq("off_date",today).maybeSingle();
    if(checkError){setTimeOffLoading(false);setMessage(checkError.message);return;}
    if(existing){setTimeOffLoading(false);setMessage("Ngày hôm nay đã có đăng ký Off trong lịch, không tạo Off đột xuất trùng.");return;}
    const {error}=await supabase.from("staff_time_off_requests").insert({business_id:profile.business_id,employee_id:targetEmployeeId,off_date:today,week_start:weekStart,status:"pending",note:TIME_OFF_EMERGENCY_NOTE,created_by:session.user.id});
    setTimeOffLoading(false);
    if(error){setMessage(error.message);return;}
    setMessage("Đã gửi Off đột xuất hôm nay đến Chủ sở hữu duyệt.");
    if(profile.role==="owner")await loadApprovals();
  }

  async function loadWeeklySchedules(selectedVenue?:number,weekStartOverride?:string){
    if(!profile)return;
    const weekStart=weekStartOverride||scheduleWeekStart;
    setWeeklyScheduleLoading(true);
    const {data,error}=await supabase.from("weekly_staff_schedules").select("id,venue_id,employee_id,work_date,week_start").eq("business_id",profile.business_id).eq("week_start",weekStart).order("work_date");
    setWeeklyScheduleLoading(false);
    if(error){setMessage(error.message);return;}
    const rows=(data||[]) as WeeklyStaffSchedule[];
    setWeeklySchedules(rows);
    setScheduleSelections(Object.fromEntries(rows.map(row=>[`${row.employee_id}-${row.work_date}`,row.venue_id])));
    if(selectedVenue)setScheduleVenueId(String(selectedVenue));
  }

  function toggleWeeklySchedule(employeeId:number,workDate:string){
    const isPast=scheduleWeekStart<nextWeekDays()[0].date;
    if((isPast&&!(profile?.role==="owner"&&scheduleHistoryEditing))||!scheduleVenueId||timeOffRequests.some(row=>row.employee_id===employeeId&&row.off_date===workDate&&row.status!=="rejected"))return;
    const key=`${employeeId}-${workDate}`,venue=Number(scheduleVenueId);
    setScheduleSelections(current=>{const next={...current};if(next[key]===venue)delete next[key];else next[key]=venue;return next;});
  }

  async function saveWeeklySchedule(){
    if(!profile||!session||!scheduleVenueId)return;
    const weekStart=scheduleWeekStart,venue=Number(scheduleVenueId);
    setWeeklyScheduleLoading(true);
    const desired=Object.entries(scheduleSelections).filter(([,venueId])=>venueId===venue).map(([key])=>{const separator=key.indexOf("-");const employee_id=Number(key.slice(0,separator));const work_date=key.slice(separator+1);return{business_id:profile.business_id,venue_id:venue,employee_id,work_date,week_start:weekStart,created_by:session.user.id};});
    const desiredKeys=new Set(desired.map(row=>`${row.employee_id}-${row.work_date}`));
    const removeIds=weeklySchedules.filter(row=>row.venue_id===venue&&!desiredKeys.has(`${row.employee_id}-${row.work_date}`)).map(row=>row.id);
    if(removeIds.length){const {error}=await supabase.from("weekly_staff_schedules").delete().in("id",removeIds);if(error){setWeeklyScheduleLoading(false);setMessage(error.message);return;}}
    if(desired.length){const {error}=await supabase.from("weekly_staff_schedules").upsert(desired,{onConflict:"business_id,employee_id,work_date"});if(error){setWeeklyScheduleLoading(false);setMessage(error.message);return;}}
    setWeeklyScheduleLoading(false);setMessage("Đã lưu lịch nhân sự cho cả tuần.");await loadWeeklySchedules(venue);
  }

  async function loadRegistrationTracking(){
    if(!profile)return;
    setRegistrationTrackingLoading(true);
    const yearStart=`${localDateValue().slice(0,4)}-01-01`;
    let offQuery=supabase.from("staff_time_off_requests")
      .select("id,employee_id,off_date,week_start,status,note,created_at,employee:employees(full_name)")
      .eq("business_id",profile.business_id).gte("off_date",yearStart).order("created_at",{ascending:false}).limit(200);
    let advanceQuery=supabase.from("salary_advance_requests")
      .select("id,employee_id,venue_id,request_month,request_type,installment,amount,note,status,created_at,employee:employees(full_name)")
      .eq("business_id",profile.business_id).gte("request_month",yearStart).order("created_at",{ascending:false}).limit(200);
    if(profile.role==="employee"&&profile.employee_id){
      offQuery=offQuery.eq("employee_id",profile.employee_id);
      advanceQuery=advanceQuery.eq("employee_id",profile.employee_id);
    }else if(profile.role==="manager"&&profile.venue_id){
      const scopedEmployeeIds=employees.filter(employee=>employee.account_venue_id===profile.venue_id).map(employee=>employee.id);
      offQuery=scopedEmployeeIds.length?offQuery.in("employee_id",scopedEmployeeIds):offQuery.eq("employee_id",-1);
      advanceQuery=advanceQuery.eq("venue_id",profile.venue_id);
    }
    const [{data:offRows,error:offError},{data:advanceRows,error:advanceError}]=await Promise.all([offQuery,advanceQuery]);
    setRegistrationTrackingLoading(false);
    if(offError||advanceError){setMessage(offError?.message||advanceError?.message||"Không thể tải danh sách gửi duyệt.");return;}
    setTrackedTimeOffRequests((offRows||[]) as unknown as TimeOffRequest[]);
    setTrackedSalaryAdvances((advanceRows||[]) as unknown as SalaryAdvance[]);
  }

  function canEditSelectedScheduleWeek(){
    return scheduleWeekStart>=nextWeekDays()[0].date||(profile?.role==="owner"&&scheduleHistoryEditing);
  }

  function assignWeeklySchedule(employeeId:number,workDate:string,venueId:number|null){
    if(!canEditSelectedScheduleWeek())return;
    const key=`${employeeId}-${workDate}`;
    setScheduleSelections(current=>{const next={...current};if(venueId)next[key]=venueId;else delete next[key];return next;});
  }

  function applySelectedDayAsWeeklyBase(sourceDate:string){
    if(!canEditSelectedScheduleWeek()){setMessage("Tuần cũ đang ở chế độ chỉ xem.");return;}
    if(!sourceDate)return;
    const days=weekDaysFromStart(scheduleWeekStart);
    const sourceAssignments=new Map<number,number>();
    lotoEmployees.forEach(employee=>{
      const venueId=scheduleSelections[`${employee.id}-${sourceDate}`];
      if(venueId)sourceAssignments.set(employee.id,venueId);
    });
    if(sourceAssignments.size===0){setMessage("Hãy xếp nhân sự cho ngày mẫu trước khi áp dụng cả tuần.");return;}
    setScheduleSelections(current=>{
      const next={...current};
      lotoEmployees.forEach(employee=>{
        const venueId=sourceAssignments.get(employee.id);
        days.forEach(day=>{
          const key=`${employee.id}-${day.date}`;
          // Giữ lịch nền tại sân khấu; ngày OFF được hiển thị đỏ như một ngoại lệ,
          // không xóa nhân sự khỏi bố cục tuần.
          if(!venueId)delete next[key];else next[key]=venueId;
        });
      });
      return next;
    });
    setMessage("Đã tạo lịch nền 7 ngày và tự loại các ngày OFF. Bạn có thể chọn từng ngày để điều chuyển ngoại lệ trước khi lưu.");
  }

  async function saveAllWeeklySchedules(){
    if(!profile||!session)return;
    if(!canEditSelectedScheduleWeek()){setMessage("Tuần cũ đang ở chế độ chỉ xem. Chủ sở hữu cần bấm Mở Chỉnh Sửa trước.");return;}
    const weekStart=scheduleWeekStart;
    const days=weekDaysFromStart(weekStart);
    const monday=days[0]?.date;
    // Lưu cả tuần luôn lấy Thứ 2 làm lịch mẫu. Người dùng có thể lưu xong
    // rồi chọn từng ngày để điều chỉnh ngoại lệ; nhờ vậy không còn tình
    // trạng chỉ có Thứ 2 được lưu còn Thứ 3–Chủ Nhật trống.
    const selectionsToSave=!monday
      ? scheduleSelections
      : (()=>{
          const cloned:{[key:string]:number}={};
          const mondayAssignments=new Map<number,number>();
          lotoEmployees.forEach(employee=>{
            const venueId=scheduleSelections[`${employee.id}-${monday}`];
            if(venueId)mondayAssignments.set(employee.id,venueId);
          });
          days.forEach(day=>mondayAssignments.forEach((venueId,employeeId)=>{cloned[`${employeeId}-${day.date}`]=venueId;}));
          return cloned;
        })();
    setWeeklyScheduleLoading(true);
    const desired=Object.entries(selectionsToSave).map(([key,venue_id])=>{const separator=key.indexOf("-");return{business_id:profile.business_id,venue_id,employee_id:Number(key.slice(0,separator)),work_date:key.slice(separator+1),week_start:weekStart,created_by:session.user.id};});
    const desiredKeys=new Set(desired.map(row=>`${row.employee_id}-${row.work_date}`));
    const removeIds=weeklySchedules.filter(row=>!desiredKeys.has(`${row.employee_id}-${row.work_date}`)).map(row=>row.id);
    if(removeIds.length){const {error}=await supabase.from("weekly_staff_schedules").delete().in("id",removeIds);if(error){setWeeklyScheduleLoading(false);setMessage(error.message);return;}}
    if(desired.length){const {error}=await supabase.from("weekly_staff_schedules").upsert(desired,{onConflict:"business_id,employee_id,work_date"});if(error){setWeeklyScheduleLoading(false);setMessage(error.message);return;}}
    setWeeklyScheduleLoading(false);setMessage("Đã sao chép lịch Thứ 2 sang Thứ 3–Chủ Nhật và lưu cả tuần.");await loadWeeklySchedules();
  }

  async function openScheduleWeek(weekStart:string){
    setScheduleWeekStart(weekStart);setScheduleDay(weekStart);setScheduleHistoryEditing(false);
    if(!profile)return;
    setWeeklyScheduleLoading(true);
    const [{data:schedules,error:scheduleError},{data:offRows,error:offError}]=await Promise.all([
      supabase.from("weekly_staff_schedules").select("id,venue_id,employee_id,work_date,week_start").eq("business_id",profile.business_id).eq("week_start",weekStart).order("work_date"),
      supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at,employee:employees(full_name)").eq("business_id",profile.business_id).eq("week_start",weekStart).order("off_date")
    ]);
    setWeeklyScheduleLoading(false);
    if(scheduleError||offError){setMessage(scheduleError?.message||offError?.message||"Không thể tải lịch tuần.");return;}
    const rows=(schedules||[]) as WeeklyStaffSchedule[];
    setWeeklySchedules(rows);
    setScheduleSelections(Object.fromEntries(rows.map(row=>[`${row.employee_id}-${row.work_date}`,row.venue_id])));
    setTimeOffRequests((offRows||[]) as unknown as TimeOffRequest[]);
  }

  function renderCompactSchedule(){
    const days=weekDaysFromStart(scheduleWeekStart);
    const selectedDay=scheduleDay||days[0]?.date||"";
    const monday=days[0]?.date||"";
    const offEmployeeIds=new Set(timeOffRequests.filter(row=>row.off_date===selectedDay&&row.status!=="rejected").map(row=>row.employee_id));
    const assignedVenueId=(employeeId:number)=>scheduleSelections[`${employeeId}-${selectedDay}`]||null;
    const assignedCount=lotoEmployees.filter(employee=>assignedVenueId(employee.id)&&!offEmployeeIds.has(employee.id)).length;
    const offEmployees=lotoEmployees.filter(employee=>offEmployeeIds.has(employee.id));
    // Người OFF vẫn nằm trong danh sách để có thể xếp lịch nền; trạng thái OFF
    // được thể hiện riêng bằng màu đỏ và không tính là đang làm trong ngày đó.
    const availableEmployees=lotoEmployees.filter(employee=>!assignedVenueId(employee.id));
    const nextWeekStart=nextWeekDays()[0].date;
    const isPastWeek=scheduleWeekStart<nextWeekStart;
    const canEditWeek=isManagement&&canEditSelectedScheduleWeek();
    const weekOptions=Array.from({length:21},(_,index)=>dateByDays(scheduleWeekStart,(index-10)*7));
    return <section className={`compact-schedule-board ${isPastWeek&&!canEditWeek?"schedule-readonly":""}`}>
      <div className="schedule-week-navigator"><button disabled={weeklyScheduleLoading} onClick={()=>void openScheduleWeek(dateByDays(scheduleWeekStart,-7))}>← Tuần Trước</button><label><span>Chọn Tuần</span><select value={scheduleWeekStart} onChange={event=>void openScheduleWeek(event.target.value)}>{weekOptions.map(start=>{const end=dateByDays(start,6);return <option key={start} value={start}>{new Date(start+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(end+"T00:00:00").toLocaleDateString("vi-VN")}</option>})}</select></label><button disabled={weeklyScheduleLoading} onClick={()=>void openScheduleWeek(dateByDays(scheduleWeekStart,7))}>Tuần Sau →</button>{isPastWeek&&profile?.role==="owner"&&<button className={scheduleHistoryEditing?"editing-history":""} onClick={()=>setScheduleHistoryEditing(current=>!current)}>{scheduleHistoryEditing?"Khóa Chỉnh Sửa":"Mở Chỉnh Sửa"}</button>}</div>
      <header className="compact-schedule-heading"><div><p className="eyebrow">{isPastWeek?"LỊCH NHÂN SỰ ĐÃ LƯU":"LỊCH NHÂN SỰ TUẦN KẾ TIẾP"}</p><h3>{!canEditWeek?(isManagement?"Xem Lịch Tuần Cũ":"Lịch Tất Cả Sân Khấu"):"Xếp Lịch Theo Từng Ngày"}</h3><span>{days[0]&&new Date(days[0].date+"T00:00:00").toLocaleDateString("vi-VN")} – {days[6]&&new Date(days[6].date+"T00:00:00").toLocaleDateString("vi-VN")}{!canEditWeek?" · Chỉ xem":""}</span></div>{canEditWeek&&<button disabled={weeklyScheduleLoading} onClick={()=>void saveAllWeeklySchedules()}>{weeklyScheduleLoading?"Đang Lưu…":"Lưu Lịch Cả Tuần"}</button>}</header>
      <nav className="compact-schedule-days">{days.map(day=>{const offIds=new Set(timeOffRequests.filter(row=>row.off_date===day.date&&row.status!=="rejected").map(row=>row.employee_id));const count=lotoEmployees.filter(employee=>scheduleSelections[`${employee.id}-${day.date}`]&&!offIds.has(employee.id)).length;return <button key={day.date} className={selectedDay===day.date?"active":""} onClick={()=>setScheduleDay(day.date)}><span>{day.label}</span><strong>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"})}</strong><small>{count} người làm · {offIds.size} OFF</small></button>})}</nav>
      <div className="compact-schedule-summary"><article><span>Đã Xếp</span><strong>{assignedCount}</strong><small>nhân sự trong ngày</small></article><article><span>Chưa Xếp</span><strong>{availableEmployees.length}</strong><small>sẵn sàng phân công</small></article><article><span>OFF</span><strong>{offEmployees.length}</strong><small>không thể phân công</small></article><article><span>Tổng Nhân Sự</span><strong>{lotoEmployees.length}</strong><small>danh sách hiện tại</small></article></div>
      <div className="compact-stage-grid">{venues.map(venue=>{const assigned=lotoEmployees.filter(employee=>assignedVenueId(employee.id)===venue.id);const working=assigned.filter(employee=>!offEmployeeIds.has(employee.id));const kepCount=working.filter(employee=>lotoRole(employee)==="kep").length;const daoCount=working.length-kepCount;return <article key={venue.id} className={assigned.length?"has-staff":"empty-stage"}><header><div><small>SÂN KHẤU</small><h4>{venue.name}</h4><span className="stage-role-count"><i className="kep">{kepCount} Kép</i><i className="dao">{daoCount} Đào</i></span></div><b>{working.length} làm · {assigned.length-working.length} OFF</b></header><div className="compact-assigned-list">{assigned.length===0?<p>Chưa có nhân sự</p>:assigned.map(employee=>{const role=lotoRole(employee);const isOff=offEmployeeIds.has(employee.id);return <div key={employee.id} className={`loto-person ${role} ${isOff?"is-off":""}`}><span>{employee.full_name}<small>{isOff?"OFF":role==="kep"?"Kép":"Đào"}</small></span><button title="Gỡ khỏi sân khấu" disabled={!canEditWeek} onClick={()=>assignWeeklySchedule(employee.id,selectedDay,null)}>×</button></div>})}</div><label>Thêm Nhân Sự<select value="" disabled={!canEditWeek||!selectedDay||availableEmployees.length===0} onChange={event=>{const id=Number(event.target.value);if(id)assignWeeklySchedule(id,selectedDay,venue.id);}}><option value="">{availableEmployees.length?"Chọn người để thêm":"Đã xếp hết nhân sự"}</option>{availableEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name} · {lotoRole(employee)==="kep"?"Kép":"Đào"}</option>)}</select></label></article>})}</div>
      <div className="compact-schedule-pools"><section><header><strong>Nhân Sự Chưa Xếp</strong><span>{availableEmployees.length} người</span></header><div>{availableEmployees.length?availableEmployees.map(employee=>{const role=lotoRole(employee);return <span key={employee.id} className={`loto-person-chip ${role}`}>{employee.full_name}<small>{role==="kep"?"Kép":"Đào"}</small></span>}):<em>Không còn nhân sự chưa xếp.</em>}</div></section><section className="off-pool"><header><strong>Nhân Sự OFF</strong><span>{offEmployees.length} người</span></header><div>{offEmployees.length?offEmployees.map(employee=><span key={employee.id}>{employee.full_name}</span>):<em>Không có nhân sự OFF.</em>}</div></section></div>
    </section>;
  }

  function renderSalaryBalances(){
    const salaryEmployees=employees.filter(employee=>employee.department&&employee.department!=="loto"&&employee.pay_type);
    const approvedStatuses=new Set(["approved","sent_to_expense","paid"]);
    const salaryBase=(employee:Employee)=>employee.pay_type==="monthly"
      ? Number(employee.monthly_salary||0)
      : employee.pay_type==="weekly"
        ? Number(employee.weekly_salary||0)
        : employee.pay_type==="daily"
          ? Number(employee.daily_rate||0)
          : Number(employee.hourly_rate||0);
    const payTypeLabel=(employee:Employee)=>employee.pay_type==="monthly"?"Lương tháng":employee.pay_type==="weekly"?"Lương tuần":employee.pay_type==="daily"?"Lương ngày":"Lương giờ";
    return <section className="salary-balance-board">
      <header><div><p className="eyebrow">ỨNG LƯƠNG TRONG THÁNG</p><h3>Lương Còn Lại Sau Khi Duyệt Ứng</h3></div><span>Còn lại = mức lương đã cấu hình − tổng ứng lương đã duyệt</span></header>
      <div className="salary-balance-grid">{salaryEmployees.map(employee=>{
        const approvedAdvance=salaryAdvances.filter(item=>item.employee_id===employee.id&&item.request_type==="salary"&&approvedStatuses.has(item.status)).reduce((sum,item)=>sum+Number(item.amount||0),0);
        const base=salaryBase(employee);
        const approvedPayment=Number(approvedPayrollPayments[employee.id]||0);
        const remaining=Math.max(0,base-approvedAdvance-approvedPayment);
        return <article key={employee.id} className={approvedAdvance>0?"has-advance":""}>
          <header className="salary-card-header"><div><strong>{employee.full_name}</strong><small>{employee.department==="game"?"Trò Chơi":employee.department==="water"?"Quán Nước":"Bộ phận khác"} · {payTypeLabel(employee)}</small></div><span className={base===0?"needs-config":remaining===0?"is-settled":"is-open"}>{base===0?"Chưa cấu hình":remaining===0?"Đã hoàn tất":"Còn phải trả"}</span></header>
          <div className="salary-card-balance"><span>Còn phải trả</span><strong>{remaining.toLocaleString("vi-VN")} đ</strong></div>
          <dl className="salary-month-details salary-card-breakdown"><div><dt>Mức lương</dt><dd>{base.toLocaleString("vi-VN")} đ</dd></div><div><dt>Đã ứng</dt><dd>{approvedAdvance.toLocaleString("vi-VN")} đ</dd></div><div><dt>Đã chi</dt><dd>{approvedPayment.toLocaleString("vi-VN")} đ</dd></div></dl>
          {employee.pay_type==="monthly"&&<div className="salary-card-dates"><span>Chốt công <b>Ngày {Number(employee.payroll_closing_day||31)}</b></span><span>Nhận lương <b>Ngày {Number(employee.salary_payment_day||10)}</b></span></div>}
          {base===0&&<em>Chưa nhập mức lương</em>}
        </article>;
      })}</div>
    </section>;
  }

  function renderSalaryAdvanceArea(){
    if(!profile)return null;
    const canProposeForStaff=profile.role==="owner"||profile.role==="manager";
    const selectedEmployeeId=Number(advanceEmployeeId||profile.employee_id||0);
    const selectedEmployee=employees.find(item=>item.id===selectedEmployeeId);
    const eligibleEmployees=employees.filter(employee=>{
      if(!(employee.pay_type||employee.bonus_advance_eligible))return false;
      if(profile.role==="owner")return true;
      if(profile.role==="manager")return Boolean(profile.venue_id)&&employee.account_venue_id===profile.venue_id;
      return employee.id===profile.employee_id;
    });
    const salaryBase=selectedEmployee?.pay_type==="monthly"
      ? Number(selectedEmployee.monthly_salary||0)
      : selectedEmployee?.pay_type==="weekly"
        ? Number(selectedEmployee.weekly_hourly_rate||0)
        : selectedEmployee?.pay_type==="daily"
          ? Number(selectedEmployee.daily_rate||0)
          : Number(selectedEmployee?.hourly_rate||0);
    const approvedStatuses=new Set(["approved","sent_to_expense","paid"]);
    const approvedAdvance=salaryAdvances.filter(item=>item.employee_id===selectedEmployeeId&&item.request_type==="salary"&&approvedStatuses.has(item.status)).reduce((sum,item)=>sum+Number(item.amount||0),0);
    const pendingAdvance=salaryAdvances.filter(item=>item.employee_id===selectedEmployeeId&&item.request_type==="salary"&&item.status==="pending").reduce((sum,item)=>sum+Number(item.amount||0),0);
    const remaining=Math.max(0,salaryBase-approvedAdvance);
    const selectedVenue=venues.find(venue=>venue.id===selectedEmployee?.account_venue_id);
    const payTypeLabel=selectedEmployee?.pay_type==="monthly"?"Lương tháng":selectedEmployee?.pay_type==="weekly"?"Lương tuần":selectedEmployee?.pay_type==="daily"?"Lương ngày":selectedEmployee?.pay_type==="hourly"?"Lương giờ":"Chưa cấu hình";
    const canRequest=Boolean(profile.employee_id||canProposeForStaff);
    return <div className="salary-advance-area-v2">
      <article><h3>Đề Xuất Ứng Lương</h3>{canRequest?<>
        {canProposeForStaff&&<label>Nhân Sự Cần Ứng<select value={selectedEmployeeId||""} onChange={e=>{setAdvanceEmployeeId(e.target.value);setAdvanceType("salary");}}><option value="">Chọn nhân sự</option>{eligibleEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>}
        {selectedEmployee&&<section className="salary-advance-profile"><header><div><small>THÔNG TIN NHÂN SỰ</small><strong>{selectedEmployee.full_name}</strong></div><b>{selectedVenue?.name||"Chưa cấu hình sân khấu"}</b></header><dl><div><dt>Loại lương</dt><dd>{payTypeLabel}</dd></div><div><dt>Mức lương</dt><dd>{salaryBase?`${salaryBase.toLocaleString("vi-VN")} đ`:"Chưa nhập"}</dd></div><div><dt>Đã ứng</dt><dd>{approvedAdvance.toLocaleString("vi-VN")} đ</dd></div><div><dt>Chờ duyệt</dt><dd>{pendingAdvance.toLocaleString("vi-VN")} đ</dd></div><div><dt>Ngày nhận lương</dt><dd>Ngày {Number(selectedEmployee.salary_payment_day||10)}</dd></div><div><dt>Còn lại</dt><dd>{salaryBase?`${remaining.toLocaleString("vi-VN")} đ`:"Chưa xác định"}</dd></div></dl></section>}
        <label>Loại Ứng<select value={advanceType} onChange={e=>setAdvanceType(e.target.value as "salary"|"bonus")}><option value="salary">Ứng Lương</option>{selectedEmployee?.bonus_advance_eligible&&<option value="bonus">Ứng Thưởng 5.000.000 đ (Tối Đa 3.000.000 đ/Tháng)</option>}</select></label>
        <label>Đợt Ứng<select value={advanceInstallment} onChange={e=>setAdvanceInstallment(e.target.value)}><option value="1">Đợt 1 Trong Tháng</option><option value="2">Đợt 2 Trong Tháng</option></select></label>
        <label>Số Tiền<MoneyInput placeholder="Nhập số tiền" value={advanceAmount} onValueChange={setAdvanceAmount} /></label>
        <small className="salary-advance-rule">Ứng lương tối đa 2 lần/tháng. Mọi đề xuất đều phải được Chủ sở hữu duyệt.</small>
        <button disabled={hrSaving||!advanceAmount||(canProposeForStaff&&!selectedEmployeeId)} onClick={()=>void requestSalaryAdvance()}>Gửi Đề Xuất Ứng {advanceType==="bonus"?"Thưởng":"Lương"}</button>
      </>:<p>Tài khoản chưa liên kết hồ sơ nhân sự nên không thể gửi đề xuất ứng lương.</p>}</article>
      <article className="salary-advance-list"><h3>Đề Xuất Trong Tháng</h3>{salaryAdvances.length===0?<p className="empty-note">Chưa có đề xuất ứng.</p>:salaryAdvances.map(item=><div key={item.id}><span><strong>{item.employee?.full_name||"Nhân Sự"} · {item.request_type==="bonus"?"Ứng Thưởng":"Ứng Lương"} · Đợt {item.installment}</strong><small>{Number(item.amount).toLocaleString("vi-VN")} đ · {item.status==="pending"?"Chờ Chủ Sở Hữu Duyệt":item.status==="rejected"?"Đã Từ Chối":item.status==="sent_to_expense"?"Đã Duyệt · Chuyển Sang Chi":"Đã Duyệt"}</small></span></div>)}</article>
    </div>;
  }

  function renderEmployeeDirectoryGroups(){
    const groups:[Employee["department"]|"other",string][]=[
      ["loto","Nhân Sự Loto"],
      ["game","Nhân Sự Trò Chơi"],
      ["water","Nhân Sự Quán Nước"],
      ["kiosk","Nhân Sự Kios"],
      ["office","Văn Phòng / Bộ Phận Khác"],
    ];
    const knownDepartments=new Set(["loto","game","water","kiosk","office"]);
    const payTypeLabel=(employee:Employee)=>employee.department==="loto"?"CASE theo File Vé":employee.pay_type==="monthly"?"Lương Tháng":employee.pay_type==="weekly"?"Lương Tuần":employee.pay_type==="daily"?"Lương Ngày":employee.pay_type==="hourly"?"Lương Giờ":"Chưa Cấu Hình";
    const baseSalary=(employee:Employee)=>employee.pay_type==="monthly"?employee.monthly_salary:employee.pay_type==="weekly"?employee.weekly_salary:employee.pay_type==="daily"?employee.daily_rate:employee.hourly_rate;
    const openEmployeeProfile=(employee:Employee)=>{setHrEmployeeId(String(employee.id));setAddingEmployee(false);setPersonnelTab("payroll");setDirectoryEmployeeId(null);setDirectoryEmployeeView(null);window.setTimeout(()=>document.querySelector(".company-employee-form,.loto-employee-form")?.scrollIntoView({behavior:"smooth",block:"start"}),80);};
    return <div className="employee-department-list">{groups.map(([department,label])=>{
      const rows=department==="office"
        ? directoryEmployees.filter(employee=>employee.department==="office"||!employee.department||!knownDepartments.has(employee.department))
        : directoryEmployees.filter(employee=>employee.department===department);
      if(rows.length===0)return null;
      return <section className={`employee-department-group department-${department}`} key={department}>
        <header><div><small>BỘ PHẬN</small><h3>{label}</h3></div><b>{rows.length} nhân sự</b></header>
        <div className="employee-directory">{rows.map(employee=><article className={directoryEmployeeId===employee.id?"selected":""} key={employee.id}>
          <div className="employee-avatar">{employee.full_name.slice(0,1)}</div>
          <strong>{employee.full_name}</strong>
          <span className="employee-department-label">{employee.job_title||label}</span>
          <dl className="employee-card-details"><div><dt>Loại Lương</dt><dd>{payTypeLabel(employee)}</dd></div>{employee.department!=="loto"&&<div><dt>Mức Lương</dt><dd>{Number(baseSalary(employee)||0).toLocaleString("vi-VN")} đ</dd></div>}<div><dt>Thưởng</dt><dd>{Number(employee.bonus_amount||0).toLocaleString("vi-VN")} đ</dd></div></dl>
          <div className="employee-card-actions">
            {employee.department==="loto"&&<><button onClick={()=>{setDirectoryEmployeeId(employee.id);setDirectoryEmployeeView("costume");setMessage("");void loadStaffCompetition(scoreMonth);}}>Nhật Ký Trang Phục</button><button onClick={()=>{setDirectoryEmployeeId(employee.id);setDirectoryEmployeeView("evaluation");setMessage("");void loadStaffCompetition(scoreMonth);}}>Bảng Đánh Giá</button></>}
            {(profile?.role==="owner"||profile?.role==="manager")&&<button className="edit-profile" onClick={()=>openEmployeeProfile(employee)}>Xem / Sửa Hồ Sơ</button>}
          </div>
        </article>)}</div>
      </section>;
    })}</div>;
  }
  async function loadStaffCompetition(month=scoreMonth) {
    if(!profile)return;
    const year=Number(month.slice(0,4));
    const nextMonth=inputDate(new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),1));
    const [{data:monthly,error:monthlyError},{data:annualMonths,error:annualError},{data:costumes,error:costumeError},{data:annualCostumes,error:annualCostumeError},{data:submissions,error:submissionError},{data:offRows,error:offError},{data:violationRows,error:violationError},{data:goRewards,error:goRewardsError}]=await Promise.all([
      supabase.from("staff_monthly_scores").select("employee_id,base_points,bonus_points,costume_deduction,support_singing_deduction,number_error_deduction,late_rehearsal_deduction,slang_deduction,weekend_off_deduction,holiday_off_deduction,tet_off_deduction,sudden_off_deduction,other_deduction,remaining_points,note").eq("business_id",profile.business_id).eq("score_month",`${month}-01`),
      supabase.from("staff_monthly_scores").select("employee_id,score_month,remaining_points").eq("business_id",profile.business_id).gte("score_month",`${year}-01-01`).lt("score_month",`${year+1}-01-01`),
      supabase.from("costume_monthly_rankings").select("employee_id,ao_dai_count,dress_count,ba_ba_count,investment_amount,submitted_on_time,photographed_at_venue,total_outfits,passed,monthly_reward,rank_position,ranking_qualified,rank_bonus,total_reward,note").eq("score_month",`${month}-01`),
      supabase.from("costume_monthly_rankings").select("employee_id,score_month,ao_dai_count,dress_count,ba_ba_count,investment_amount,submitted_on_time,photographed_at_venue,total_outfits,passed,monthly_reward,rank_position,ranking_qualified,rank_bonus,total_reward,note").eq("business_id",profile.business_id).gte("score_month",`${year}-01-01`).lt("score_month",`${year+1}-01-01`),
      supabase.from("costume_submissions").select("id,employee_id,venue_id,submission_date,costume_type,quantity,note,photo_path,created_at").gte("submission_date",`${month}-01`).lt("submission_date",inputDate(new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),1))).order("submission_date",{ascending:false}).order("created_at",{ascending:false}),
      supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at").gte("off_date",`${month}-01`).lt("off_date",nextMonth).neq("status","rejected"),
      supabase.from("staff_competition_violations").select("id,employee_id,violation_date,violation_type,occurrence_count,points,note,created_at").gte("violation_date",`${month}-01`).lt("violation_date",nextMonth).order("violation_date",{ascending:false}).order("created_at",{ascending:false}),
      supabase.from("go_an_lac_night_rewards").select("employee_id,performance_date,revenue_amount,reward_amount").eq("business_id",profile.business_id).gte("performance_date",`${year}-01-01`).lt("performance_date",`${year+1}-01-01`),
    ]);
    if(monthlyError||annualError||costumeError||annualCostumeError||submissionError||offError||violationError||goRewardsError){setMessage(monthlyError?.message||annualError?.message||costumeError?.message||annualCostumeError?.message||submissionError?.message||offError?.message||violationError?.message||goRewardsError?.message||"Không thể tải bảng thi đua.");return;}
    setGoAnLacNightRewards((goRewards||[]) as GoAnLacNightReward[]);
    const monthlyOffRows=(offRows||[]) as TimeOffRequest[];
    setCompetitionOffRequests(monthlyOffRows);
    setCompetitionViolations((violationRows||[]) as CompetitionViolation[]);
    const currentMonthScores=Object.fromEntries((monthly||[]).map((row:any)=>{const normalized={...row,...automaticOffDeductions(monthlyOffRows,row.employee_id,month)} as MonthlyScore;return [row.employee_id,{...normalized,remaining_points:competitionRemainingPoints(normalized)}];})) as Record<number,MonthlyScore>;
    setMonthlyScores(currentMonthScores);
    const previousMonthsByEmployee=(annualMonths||[]).reduce((totals:Record<number,number>,row:any)=>{
      if(String(row.score_month).slice(0,7)!==month)totals[row.employee_id]=(totals[row.employee_id]||0)+Number(row.remaining_points||0);
      return totals;
    },{});
    const annualWithCurrentMonth=Object.fromEntries(competitionEmployees.map(employee=>{
      const storedCurrent=currentMonthScores[employee.id];
      const currentScore=storedCurrent||{employee_id:employee.id,base_points:30,bonus_points:0,costume_deduction:0,support_singing_deduction:0,number_error_deduction:0,late_rehearsal_deduction:0,slang_deduction:0,weekend_off_deduction:0,holiday_off_deduction:0,tet_off_deduction:0,sudden_off_deduction:0,other_deduction:0,remaining_points:30,note:null};
      const recalculated={...currentScore,...competitionViolationTotals((violationRows||[]) as CompetitionViolation[],employee.id),...automaticOffDeductions(monthlyOffRows,employee.id,month)} as MonthlyScore;
      recalculated.remaining_points=competitionRemainingPoints(recalculated);
      const totalRemaining=Number(previousMonthsByEmployee[employee.id]||0)+recalculated.remaining_points;
      const specialBonus=(goRewards||[]).filter((reward:any)=>Number(reward.employee_id)===employee.id).reduce((sum:number,reward:any)=>sum+Number(reward.reward_amount||0),0);
      return [employee.id,{employee_id:employee.id,total_remaining_points:totalRemaining,payout_amount:totalRemaining*20000,special_bonus:specialBonus} satisfies AnnualScore];
    }));
    setAnnualScores(annualWithCurrentMonth);
    setCostumeScores(Object.fromEntries((costumes||[]).map((row:any)=>[row.employee_id,row])));
    setAnnualCostumeScores((annualCostumes||[]) as AnnualCostumeScore[]);
    const submissionRows=await Promise.all(((submissions||[]) as CostumeSubmission[]).map(async row=>{
      if(!row.photo_path)return row;
      const {data:signed}=await supabase.storage.from("staff-media").createSignedUrl(row.photo_path,3600);
      return {...row,signed_url:signed?.signedUrl||null};
    }));
    setCostumeSubmissions(submissionRows.filter(row=>{
      const employee=employees.find(item=>item.id===row.employee_id);
      if(!employee)return true;
      const normalizedName=employee.full_name.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
      return !costumeCompetitionExcludedNames.has(normalizedName);
    }));
  }

  function competitionViolationTotals(rows:CompetitionViolation[],employeeId:number){
    const totals={costume_deduction:0,support_singing_deduction:0,number_error_deduction:0,late_rehearsal_deduction:0,slang_deduction:0,other_deduction:0};
    rows.filter(row=>row.employee_id===employeeId).forEach(row=>{totals[row.violation_type]+=Number(row.points||0);});
    return totals;
  }
  async function persistCompetitionViolationTotals(employeeId:number,rows:CompetitionViolation[]){
    if(!profile||!session)return;
    const current=scoreFields(employeeId);
    const next={...current,...competitionViolationTotals(rows,employeeId),...automaticOffDeductions(competitionOffRequests,employeeId,scoreMonth),tet_off_deduction:0};
    const {remaining_points,...values}=next;
    const {error}=await supabase.from("staff_monthly_scores").upsert({...values,business_id:profile.business_id,score_month:`${scoreMonth}-01`,updated_by:session.user.id},{onConflict:"business_id,employee_id,score_month"});
    if(error)throw error;
  }
  async function addCompetitionViolation(){
    if(!profile||!session||!canEditCompetition||!competitionViolationForm.employeeId||!competitionViolationForm.date||!competitionViolationForm.type)return;
    const count=Math.max(1,Number(competitionViolationForm.count)||1);
    const standard=competitionViolationTicks.find(([field])=>field===competitionViolationForm.type)?.[2]||0;
    const pointsEach=competitionViolationForm.type==="other_deduction"?Math.max(1,Number(competitionViolationForm.points)||1):standard;
    setCompetitionViolationSaving(true);setMessage("");
    const {data,error}=await supabase.from("staff_competition_violations").insert({business_id:profile.business_id,employee_id:Number(competitionViolationForm.employeeId),violation_date:competitionViolationForm.date,violation_type:competitionViolationForm.type,occurrence_count:count,points:pointsEach*count,note:competitionViolationForm.note.trim()||null,created_by:session.user.id}).select("id,employee_id,violation_date,violation_type,occurrence_count,points,note,created_at").single();
    if(error){setMessage(error.message);setCompetitionViolationSaving(false);return;}
    try{await persistCompetitionViolationTotals(Number(competitionViolationForm.employeeId),[...competitionViolations,data as CompetitionViolation]);setCompetitionViolationConfirmedEmployeeId(Number(competitionViolationForm.employeeId));setCompetitionViolationForm(current=>({...current,type:"",count:"1",points:"",note:""}));setMessage("Đã ghi nhận lỗi theo ngày và cập nhật điểm tháng.");await loadStaffCompetition(scoreMonth);}catch(syncError:any){setMessage(syncError?.message||"Đã lưu lỗi nhưng chưa đồng bộ được điểm tháng.");}
    setCompetitionViolationSaving(false);
  }
  async function deleteCompetitionViolation(id:number){
    if(!profile||!isManagement)return;
    const target=competitionViolations.find(row=>row.id===id);if(!target)return;
    setCompetitionViolationSaving(true);setMessage("");
    const {error}=await supabase.from("staff_competition_violations").delete().eq("id",id).eq("business_id",profile.business_id);
    if(error){setMessage(error.message);setCompetitionViolationSaving(false);return;}
    const nextRows=competitionViolations.filter(row=>row.id!==id);
    try{await persistCompetitionViolationTotals(target.employee_id,nextRows);setMessage("Đã xóa lần vi phạm và tính lại điểm tháng.");await loadStaffCompetition(scoreMonth);}catch(syncError:any){setMessage(syncError?.message||"Đã xóa lịch sử nhưng chưa đồng bộ được điểm tháng.");}
    setCompetitionViolationSaving(false);
  }
  const scoreFields=(employeeId:number):MonthlyScore=>{
    const base=monthlyScores[employeeId]||{employee_id:employeeId,base_points:30,bonus_points:0,costume_deduction:0,support_singing_deduction:0,number_error_deduction:0,late_rehearsal_deduction:0,slang_deduction:0,weekend_off_deduction:0,holiday_off_deduction:0,tet_off_deduction:0,sudden_off_deduction:0,other_deduction:0,remaining_points:30,note:null};
    const next={...base,...competitionViolationTotals(competitionViolations,employeeId),...automaticOffDeductions(competitionOffRequests,employeeId,scoreMonth)};
    return {...next,remaining_points:competitionRemainingPoints(next)};
  };
  function updateScoreField(employeeId:number,field:keyof MonthlyScore,value:string){if(!canEditCompetition)return;setMonthlyScoreConfirmedIds(current=>{const next=new Set(current);next.delete(employeeId);return next;});setMonthlyScores(current=>{const row=scoreFields(employeeId);const next={...row,[field]:field==="note"?value:Number(value)||0,tet_off_deduction:0} as MonthlyScore;next.remaining_points=competitionRemainingPoints(next);return{...current,[employeeId]:next};});}
  function toggleCompetitionViolation(employeeId:number,field:typeof competitionViolationTicks[number][0],points:number,checked:boolean){if(!canEditCompetition)return;updateScoreField(employeeId,field,checked?String(points):"0");}
  async function saveMonthlyScore(employeeId:number){if(!profile||!session||!canEditCompetition||monthlyScoreSavingId!==null||monthlyScoreConfirmedIds.has(employeeId))return;setMonthlyScoreSavingId(employeeId);const row={...scoreFields(employeeId),...automaticOffDeductions(competitionOffRequests,employeeId,scoreMonth),tet_off_deduction:0};const {remaining_points,...values}=row;const {error}=await supabase.from("staff_monthly_scores").upsert({...values,business_id:profile.business_id,score_month:scoreMonth+"-01",updated_by:session.user.id},{onConflict:"business_id,employee_id,score_month"});if(error)setMessage(error.message);else{setMonthlyScoreConfirmedIds(current=>new Set(current).add(employeeId));setMessage("Đã xác nhận điểm thi đua của nhân viên.");await loadStaffCompetition();}setMonthlyScoreSavingId(null);}
  function renderCompetitionViolationBoard(){
    const selectedEmployeeId=profile?.role==="employee"?Number(profile.employee_id||0):Number(competitionViolationForm.employeeId||0);
    const selectedHistory=competitionViolations.filter(row=>row.employee_id===selectedEmployeeId);
    const selectedEmployee=competitionEmployees.find(employee=>employee.id===selectedEmployeeId);
    const selectedScore=selectedEmployeeId?scoreFields(selectedEmployeeId):null;
    const selectedAnnual=selectedEmployeeId?annualScores[selectedEmployeeId]:null;
    const selectedCumulativePoints=selectedScore?Number(selectedAnnual?.total_remaining_points||selectedScore.remaining_points):0;
    const selectedGoAnLacRewards=goAnLacNightRewards.filter(reward=>reward.employee_id===selectedEmployeeId);
    const selectedGoAnLacTotal=selectedGoAnLacRewards.reduce((sum,reward)=>sum+Number(reward.reward_amount||0),0);
    const selectedCostumeAnnual=selectedEmployeeId?costumeAnnualSummary(selectedEmployeeId):{passedMonths:0,totalOutfits:0,totalReward:0};
    const selectedYearReward=Number(selectedAnnual?.payout_amount||0)+selectedCostumeAnnual.totalReward+selectedGoAnLacTotal;
    const violationLabel=(type:CompetitionViolation["violation_type"])=>competitionViolationTicks.find(([field])=>field===type)?.[1]||"Khác";
    return <section className="violation-board">
      <header><div><p className="eyebrow">THANG ĐIỂM 30</p><h3>Điểm Thi Đua Nhân Sự</h3><span>Mỗi lần vi phạm được lưu riêng theo ngày. Điểm tháng và tiền thưởng cuối năm tự cộng từ lịch sử.</span></div><b>Tháng {scoreMonth.slice(5,7)}/{scoreMonth.slice(0,4)}</b></header>
      {selectedEmployeeId&&<section className="go-an-lac-reward-history"><header><div><p className="eyebrow">THƯỞNG ĐẶC BIỆT GÒ AN LẠC</p><h4>{selectedEmployee?.full_name||"Nhân sự"}</h4><span>Thưởng từng đêm diễn: 4% doanh thu Loto khi đêm diễn vượt 10.000.000 đ.</span></div><b>{selectedGoAnLacTotal.toLocaleString("vi-VN")} đ</b></header>{selectedGoAnLacRewards.length===0?<p className="empty-note">Chưa có thưởng đặc biệt được ghi nhận trong năm đang xem.</p>:<div>{selectedGoAnLacRewards.map(reward=><article key={`${reward.employee_id}-${reward.performance_date}`}><time>{new Date(reward.performance_date+"T12:00:00").toLocaleDateString("vi-VN")}</time><span>Doanh thu Loto {Number(reward.revenue_amount).toLocaleString("vi-VN")} đ</span><strong>4% · {Number(reward.reward_amount).toLocaleString("vi-VN")} đ</strong></article>)}</div>}</section>}
      {selectedEmployeeId&&<section className="go-an-lac-reward-history"><header><div><p className="eyebrow">TỔNG KẾT THƯỞNG TRONG NĂM</p><h4>{selectedEmployee?.full_name||"Nhân sự"}</h4><span>Dữ liệu tích lũy từ các tháng đã được chọn và xác nhận.</span></div><b>{selectedYearReward.toLocaleString("vi-VN")} đ</b></header><div className="violation-history-totals"><span>Điểm tích lũy <b>{selectedCumulativePoints.toLocaleString("vi-VN")}</b></span><span>Thưởng điểm <b>{Number(selectedAnnual?.payout_amount||0).toLocaleString("vi-VN")} đ</b></span><span>Trang phục đạt <b>{selectedCostumeAnnual.passedMonths} tháng · {selectedCostumeAnnual.totalOutfits} bộ</b></span><span>Thưởng trang phục <b>{selectedCostumeAnnual.totalReward.toLocaleString("vi-VN")} đ</b></span></div></section>}
      {!canEditCompetition&&<div className="competition-readonly-notice">Bạn chỉ được xem điểm và lịch sử trừ điểm của chính mình.</div>}
      {canEditCompetition&&<section className="violation-entry-panel"><div><p className="eyebrow">GHI NHẬN LỖI MỚI</p><h4>Trừ Điểm Theo Ngày</h4></div><div className="violation-entry-grid"><label>Nhân Sự<select value={competitionViolationForm.employeeId} onChange={e=>{setCompetitionViolationConfirmedEmployeeId(null);setCompetitionViolationForm(current=>({...current,employeeId:e.target.value}));}}><option value="">— Chọn nhân sự —</option>{competitionEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><label>Ngày Vi Phạm<input type="date" value={competitionViolationForm.date} onChange={e=>setCompetitionViolationForm(current=>({...current,date:e.target.value}))} /></label><label>Lỗi<select value={competitionViolationForm.type} onChange={e=>{setCompetitionViolationConfirmedEmployeeId(null);setCompetitionViolationForm(current=>({...current,type:e.target.value}));}}><option value="">— Chọn lỗi —</option>{competitionViolationTicks.map(([field,label,points])=><option key={field} value={field}>{label} (−{points}/lần)</option>)}<option value="other_deduction">Lỗi Khác</option></select></label><label>Số Lần<input type="number" min="1" value={competitionViolationForm.count} onChange={e=>setCompetitionViolationForm(current=>({...current,count:e.target.value}))} /></label>{competitionViolationForm.type==="other_deduction"&&<label>Điểm / Lần<input type="number" min="1" value={competitionViolationForm.points} onChange={e=>setCompetitionViolationForm(current=>({...current,points:e.target.value}))} /></label>}<label className="violation-entry-note">Nội Dung Lỗi<input placeholder="Ghi rõ lỗi để xem lại" value={competitionViolationForm.note} onChange={e=>setCompetitionViolationForm(current=>({...current,note:e.target.value}))} /></label><button type="button" className={competitionViolationConfirmedEmployeeId===Number(competitionViolationForm.employeeId)?"violation-submit-button confirmed":"violation-submit-button"} disabled={competitionViolationSaving||competitionViolationConfirmedEmployeeId===Number(competitionViolationForm.employeeId)||!competitionViolationForm.employeeId||!competitionViolationForm.date||!competitionViolationForm.type} onClick={()=>void addCompetitionViolation()}><span aria-hidden="true">{competitionViolationSaving?"…":competitionViolationConfirmedEmployeeId===Number(competitionViolationForm.employeeId)?"✓":"−"}</span><strong>{competitionViolationSaving?"Đang Ghi Nhận…":competitionViolationConfirmedEmployeeId===Number(competitionViolationForm.employeeId)?"Đã Ghi Nhận":"Ghi Nhận Trừ Điểm"}</strong></button></div></section>}
      <section className="violation-history-panel">
        <div className="violation-history-heading"><div><p className="eyebrow">LỊCH SỬ TRỪ ĐIỂM</p><h4>{selectedEmployee?.full_name||"Chọn nhân sự để xem"}</h4></div>{canEditCompetition&&<label>Xem Theo Nhân Viên<select value={competitionViolationForm.employeeId} onChange={e=>{setCompetitionViolationConfirmedEmployeeId(null);setCompetitionViolationForm(current=>({...current,employeeId:e.target.value}));}}><option value="">— Chọn nhân sự —</option>{competitionEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>}</div>
        {!selectedEmployeeId?<p className="empty-note">Chọn nhân sự để xem đầy đủ thông tin điểm thi đua.</p>:selectedScore&&<>
          <div className="violation-history-summary">
            <div className="violation-history-person"><strong>{selectedEmployee?.full_name||"Nhân sự"}</strong><span>Tháng {scoreMonth.slice(5,7)}/{scoreMonth.slice(0,4)} · {selectedHistory.length} lần ghi nhận</span><b>{selectedScore.remaining_points}<small>/ 30 điểm</small></b></div>
            <div className="violation-history-metrics">{competitionViolationTicks.map(([field,label])=><span className={selectedScore[field]>0?"has-deduction":""} key={field}><small>{label}</small><b>−{Number(selectedScore[field]||0)} điểm</b></span>)}<span className={selectedScore.other_deduction>0?"has-deduction":""}><small>Lỗi Khác</small><b>−{Number(selectedScore.other_deduction||0)} điểm</b></span><span><small>Điểm Thưởng</small><b>+{Number(selectedScore.bonus_points||0)} điểm</b></span></div>
            <div className="violation-history-off"><strong>OFF tự động từ lịch nhân sự</strong><span>Thứ 7 / Chủ Nhật <b>−{Number(selectedScore.weekend_off_deduction||0)}</b></span><span>Ngày Lễ <b>−{Number(selectedScore.holiday_off_deduction||0)}</b></span><span>OFF Đột Xuất <b>−{Number(selectedScore.sudden_off_deduction||0)}</b></span><span>Tết <b>0</b></span></div>
            <div className="violation-history-totals"><span>Điểm còn lại tháng <b>{selectedScore.remaining_points}</b></span><span>Tổng điểm còn lại trong năm <b>{selectedCumulativePoints.toLocaleString("vi-VN")}</b></span><span>Thành tiền thưởng <b>{(selectedCumulativePoints*20000).toLocaleString("vi-VN")} đ</b></span><span>Ghi chú tháng <b>{selectedScore.note?.trim()||"Không có"}</b></span></div>
          </div>
          <h5 className="violation-history-list-title">Chi tiết từng lần ghi nhận</h5>
          {selectedHistory.length===0?<p className="empty-note">Không có vi phạm được ghi nhận trong tháng này. Tất cả mục đều bằng 0.</p>:<div className="violation-history-list">{selectedHistory.map(row=><article key={row.id}><time>{new Date(row.violation_date+"T00:00:00").toLocaleDateString("vi-VN")}</time><div><strong>{violationLabel(row.violation_type)}{row.occurrence_count>1?` × ${row.occurrence_count} lần`:""}</strong><span>{row.note||"Không có ghi chú"}</span></div><b>−{row.points} điểm</b>{canEditCompetition&&<button disabled={competitionViolationSaving} onClick={()=>void deleteCompetitionViolation(row.id)}>Xóa</button>}</article>)}</div>}
        </>}
      </section>
      <div className="violation-employee-list">{competitionEmployees.map(employee=>{const row=scoreFields(employee.id);const annual=annualScores[employee.id];const employeeViolations=competitionViolations.filter(item=>item.employee_id===employee.id);const cumulativePoints=Number(annual?.total_remaining_points||row.remaining_points);return <article key={`violation-${employee.id}`}><div className="violation-person"><strong>{employee.full_name}</strong><span>{employeeViolations.length} lần ghi nhận trong tháng</span><b>{row.remaining_points}<small>/ 30 điểm</small></b></div><div className="violation-options">{competitionViolationTicks.map(([field,label])=><span key={field} className={row[field]>0?"checked":""}><b>{label}</b><small>−{row[field]} điểm</small></span>)}</div><div className="automatic-off-score"><strong>OFF tự động từ lịch nhân sự</strong><span>Thứ 7 / Chủ Nhật <b>−{row.weekend_off_deduction}</b></span><span>Ngày lễ <b>−{row.holiday_off_deduction}</b></span><span>Đột xuất <b>−{row.sudden_off_deduction}</b></span><span>Tết <b>0</b></span></div><div className="violation-footer">{canEditCompetition&&<label>Điểm thưởng<input type="number" min="0" value={row.bonus_points||""} onChange={event=>updateScoreField(employee.id,"bonus_points",event.target.value)} /></label>}<label className="violation-note">Ghi chú tháng<input disabled={!canEditCompetition} value={row.note||""} onChange={event=>updateScoreField(employee.id,"note",event.target.value)} /></label><div className="annual-score-mini"><span>Điểm còn lại tháng {scoreMonth.slice(5,7)} <b>{row.remaining_points}</b></span><span>Tổng điểm còn lại trong năm <b>{cumulativePoints.toLocaleString("vi-VN")}</b></span><span>Thành tiền thưởng <b>{(cumulativePoints*20000).toLocaleString("vi-VN")} đ</b></span></div>{canEditCompetition&&<button className={monthlyScoreConfirmedIds.has(employee.id)?"score-confirm-button confirmed":"score-confirm-button"} disabled={monthlyScoreSavingId!==null||monthlyScoreConfirmedIds.has(employee.id)} onClick={()=>void saveMonthlyScore(employee.id)}>{monthlyScoreSavingId===employee.id?"Đang Xác Nhận…":monthlyScoreConfirmedIds.has(employee.id)?"Đã Xác Nhận":"Xác Nhận"}</button>}</div></article>})}</div>
      <footer><b>Quy tắc OFF:</b><span>Thứ 7: −5 · Chủ Nhật: −5 · Off liên tiếp Thứ 7 và Chủ Nhật trong cùng tuần: tổng −15 · Lễ: −10 · Off đột xuất: −5 · Tết: 0 điểm.</span></footer>
    </section>;
  }  const costumeFields=(employeeId:number):CostumeScore=>costumeScores[employeeId]||{employee_id:employeeId,ao_dai_count:0,dress_count:0,ba_ba_count:0,investment_amount:0,submitted_on_time:true,photographed_at_venue:true,total_outfits:0,passed:false,monthly_reward:0,rank_position:null,ranking_qualified:false,rank_bonus:0,total_reward:0,note:null};
  const costumeAnnualSummary=(employeeId:number)=>{
    const rows=annualCostumeScores.filter(row=>row.employee_id===employeeId);
    return {passedMonths:rows.filter(row=>row.passed).length,totalOutfits:rows.reduce((sum,row)=>sum+Number(row.total_outfits||0),0),totalReward:rows.reduce((sum,row)=>sum+Number(row.total_reward||0),0)};
  };
  function updateCostumeField(employeeId:number,field:keyof CostumeScore,value:string|boolean){if(profile?.role!=="owner")return;setCostumeScores(current=>{const row=current[employeeId]||costumeFields(employeeId);const next={...row,[field]:typeof value==="boolean"?value:field==="note"?value:Number(value)||0};next.total_outfits=next.ao_dai_count+next.dress_count+next.ba_ba_count;next.passed=next.ao_dai_count>=2&&next.dress_count>=2&&next.ba_ba_count>=1&&next.submitted_on_time&&next.photographed_at_venue;next.monthly_reward=next.passed?500000:0;next.total_reward=next.monthly_reward+next.rank_bonus;return{...current,[employeeId]:next};});}
  async function saveCostumeScore(employeeId:number){if(!profile||!session||profile.role!=="owner")return;const row=costumeFields(employeeId);const {total_outfits,passed,monthly_reward,rank_position,ranking_qualified,rank_bonus,total_reward,...values}=row;const {error}=await supabase.from("costume_monthly_scores").upsert({...values,business_id:profile.business_id,score_month:`${scoreMonth}-01`,updated_by:session.user.id},{onConflict:"business_id,employee_id,score_month"});if(error)setMessage(error.message);else{setMessage("Đã cập nhật thi đua trang phục tháng.");await loadStaffCompetition();}}
  async function uploadMyCostume(){if(!profile||!directoryEmployeeId||!costumeUploadFile)return;setCostumeUploading(true);const signatures=await costumePhotoSignatures(costumeUploadFile);const extension=costumeUploadFile.name.split(".").pop()?.toLowerCase()||"jpg";const path=`${profile.business_id}/${directoryEmployeeId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;const {error:uploadError}=await supabase.storage.from("staff-media").upload(path,costumeUploadFile,{contentType:costumeUploadFile.type,upsert:false});if(uploadError){setMessage(uploadError.message);setCostumeUploading(false);return;}const today=localDateValue();const {error}=await supabase.rpc("add_costume_submission",{p_employee_id:directoryEmployeeId,p_submission_date:today,p_costume_type:costumeUploadType,p_quantity:1,p_note:null,p_photo_path:path,p_photo_hash:signatures.photoHash,p_photo_fingerprint:signatures.photoFingerprint});if(error){await supabase.storage.from("staff-media").remove([path]);setMessage(error.message);}else{setMessage(`Đã tải ảnh trang phục ngày ${new Date(today+"T00:00:00").toLocaleDateString("vi-VN")} và cập nhật thi đua tháng.`);setCostumeUploadFile(null);}setCostumeUploading(false);}
  async function uploadOwnerCostume(){
    if(!canManageAllCompetition||!ownerCostumeEmployeeId||!ownerCostumeVenueId||!ownerCostumeFile)return;
    setOwnerCostumeUploading(true);
    const employeeId=Number(ownerCostumeEmployeeId),venueId=Number(ownerCostumeVenueId);
    const signatures=await costumePhotoSignatures(ownerCostumeFile);
    const extension=ownerCostumeFile.name.split(".").pop()?.toLowerCase()||"jpg";
    const path=`${profile.business_id}/${venueId}/${employeeId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const {error:uploadError}=await supabase.storage.from("staff-media").upload(path,ownerCostumeFile,{contentType:ownerCostumeFile.type,upsert:false});
    if(uploadError){setMessage(uploadError.message);setOwnerCostumeUploading(false);return;}
    const today=localDateValue();
    const {error}=await supabase.rpc("add_costume_submission",{p_employee_id:employeeId,p_venue_id:venueId,p_submission_date:today,p_costume_type:ownerCostumeType,p_quantity:1,p_note:profile?.role==="owner"?"Chủ sở hữu gửi thay nhân sự":"Phụ trách thi đua gửi thay nhân sự",p_photo_path:path,p_photo_hash:signatures.photoHash,p_photo_fingerprint:signatures.photoFingerprint});
    if(error){await supabase.storage.from("staff-media").remove([path]);setMessage(error.message);}
    else{
      const employeeName=employees.find(employee=>employee.id===employeeId)?.full_name||"Nhân sự";
      const venueName=venues.find(venue=>venue.id===venueId)?.name||"sân khấu";
      setMessage(`Đã gửi ảnh thi đua thay ${employeeName} tại ${venueName}.`);
      setOwnerCostumeFile(null);
      await loadStaffCompetition(scoreMonth);
    }
    setOwnerCostumeUploading(false);
  }
  async function loadCostumePlanReferences(){
    if(!profile)return;
    const {data,error}=await supabase.from("costume_plan_references").select("id,plan_month,image_path,created_at").eq("business_id",profile.business_id).eq("plan_month",`${costumePlanMonth}-01`).order("created_at",{ascending:false});
    if(error){setCostumeReferences([]);return;}
    const rows=await Promise.all(((data||[]) as CostumePlanReference[]).map(async row=>{
      const {data:signed}=await supabase.storage.from("staff-media").createSignedUrl(row.image_path,3600);
      return {...row,signed_url:signed?.signedUrl};
    }));
    setCostumeReferences(rows);
  }
  async function uploadCostumePlanReferences(){
    if(!profile||!session||costumeReferenceFiles.length===0||costumeReferenceUploading)return;
    setCostumeReferenceUploading(true);
    for(const file of costumeReferenceFiles.slice(0,10)){
      const extension=file.name.split(".").pop()?.toLowerCase()||"jpg";
      const path=`${profile.business_id}/costume-plans/${costumePlanMonth}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
      const {error:uploadError}=await supabase.storage.from("staff-media").upload(path,file,{contentType:file.type,upsert:false});
      if(uploadError){setMessage(uploadError.message);setCostumeReferenceUploading(false);return;}
      const {error}=await supabase.from("costume_plan_references").insert({business_id:profile.business_id,plan_month:`${costumePlanMonth}-01`,image_path:path,created_by:session.user.id});
      if(error){await supabase.storage.from("staff-media").remove([path]);setMessage(error.message);setCostumeReferenceUploading(false);return;}
    }
    setCostumeReferenceFiles([]);
    await loadCostumePlanReferences();
    setMessage("Đã tải hình tham khảo cho lịch trang phục tháng.");
    setCostumeReferenceUploading(false);
  }

  async function loadTicketWorkspace(shiftId: number, shiftVenueId = activeShift?.venue_id) {
    setTicketLoading(true);
    ticketDraftReadyShiftRef.current=null;
    ticketSkipDraftPersistRef.current=true;
    ticketPendingRemoteDraftRef.current=null;
    ticketLocalDirtyRef.current=false;
    ticketLastServerDraftAtRef.current="";
    setTicketDraftStatus("idle");
    const businessId=Number(profile?.business_id||0);
    const scopedVenueId=Number(shiftVenueId||0);
    if (!businessId||!scopedVenueId) { setTicketInventory([]); setTicketInventoryCatalog([]); setGiftOptions([]); setTicketLoading(false); return; }
    const {data:scopedShift,error:shiftScopeError}=await supabase.from("shifts").select("id").eq("id",shiftId).eq("business_id",businessId).eq("venue_id",scopedVenueId).maybeSingle();
    if(shiftScopeError||!scopedShift){
      setTicketInventory([]);setTicketInventoryCatalog([]);setGiftOptions([]);setShiftStaff([]);setSelectedStaff([]);
      setMessage("File Vé không thuộc sân khấu đang chọn. Hệ thống đã chặn để tránh dùng chéo kho vé.");
      setTicketLoading(false);return;
    }
    const { data: sourceData } = await supabase.from("venue_ticket_sources").select("venue_id").eq("business_id",businessId).eq("venue_id",scopedVenueId).eq("is_active",true).maybeSingle();
    if (!sourceData) { setTicketInventory([]); setTicketInventoryCatalog([]); setGiftOptions([]); setMessage("Sân khấu này chưa cấu hình sheet xuất vé riêng."); setTicketLoading(false); return; }
    const [{ data: staffData, error: staffError }, { data: inventoryData, error: inventoryError }, { data: giftData, error: giftError }] = await Promise.all([
      supabase.from("shift_staff").select("employee_id,case_mode,allowance,employee:employees(id,full_name,weekday_case,weekend_case,holiday_case,tet_case,half_case,support_100k,support_200k)").eq("shift_id", shiftId),
      supabase.from("ticket_inventory").select("id,code,handover_quantity,gift_value").eq("business_id",businessId).eq("venue_id",scopedVenueId).eq("status", "active").order("code"),
      supabase.from("gift_options").select("amount").eq("business_id",businessId).eq("is_active",true).order("amount"),
    ]);
    const stageInventoryIds=(inventoryData||[]).map((item:any)=>Number(item.id)).filter(Boolean);
    const reservedResult=stageInventoryIds.length
      ? await supabase.from("ticket_round_codes").select("ticket_inventory_id,round:round_id!inner(status,shift_id,reconciliation_confirmed_at,reconciliation_variance)").in("ticket_inventory_id",stageInventoryIds)
      : {data:[],error:null};
    const reservedData=reservedResult.data;
    const reservedError=reservedResult.error;
    if (staffError || inventoryError || giftError || reservedError) setMessage("Chưa thể tải dữ liệu File Làm Việc.");
    const people = (staffData || []).map((row: any) => row.employee).filter(Boolean) as ShiftPerson[];
    setAllowances(Object.fromEntries((staffData || []).filter((row:any)=>Number(row.allowance)>0).map((row:any)=>[row.employee_id,String(row.allowance)])));
    if (staffData?.[0]?.case_mode) setCaseMode(staffData[0].case_mode as typeof caseMode);
    setShiftStaff(people);
    setSelectedStaff(people.map((person) => person.id));
    const reservedByOtherShift=new Set((reservedData||[]).filter((row:any)=>{
      const round=Array.isArray(row.round)?row.round[0]:row.round;
      const stillAwaiting=!round||round.status!=="verified"||(!round.reconciliation_confirmed_at&&Number(round.reconciliation_variance||0)!==0);
      return Number(round?.shift_id)!==shiftId&&stillAwaiting;
    }).map((row:any)=>Number(row.ticket_inventory_id)));
    const inventoryCatalog=(inventoryData || []) as TicketItem[];
    setTicketInventoryCatalog(inventoryCatalog);
    setTicketInventory(inventoryCatalog.filter(item=>!reservedByOtherShift.has(item.id)));
    const configuredGifts=(giftData || []).map((row: { amount: number | string }) => Number(row.amount)).filter(Boolean);
    const inventoryGifts=(inventoryData || []).map((row:any)=>Number(row.gift_value||0)).filter(Boolean);
    setGiftOptions([...new Set([...DEFAULT_GIFT_OPTIONS,...configuredGifts,...inventoryGifts])].sort((a,b)=>a-b));
    const [{ data: savedRounds },{ data: savedDraft,error:draftError }] = await Promise.all([
      supabase.from("ticket_rounds").select("client_id,sequence_no,ticket_price,gift_value,ticket_round_codes(slot,ticket_inventory:ticket_inventory_id(code)),ticket_sales(employee_id,quantity)").eq("shift_id",shiftId).order("sequence_no"),
      supabase.from("ticket_shift_drafts").select("payload,extra_roles,updated_at").eq("shift_id",shiftId).maybeSingle(),
    ]);
    let restoredRows:TicketRow[]=(savedRounds||[]).map((round: any) => ({
      id: round.client_id,
      codes: [1,2,3,4].map(slot => round.ticket_round_codes?.find((item: any) => item.slot === slot)?.ticket_inventory?.code || ""),
      quantities: Object.fromEntries((round.ticket_sales || []).map((sale: any) => [sale.employee_id,String(sale.quantity)])),
      price: Number(round.ticket_price), gift: Number(round.gift_value) ? String(round.gift_value) : "",
      ...promotionMetaFromClientId(round.client_id),
    }));
    let draftPayload=savedDraft?.payload as Partial<TicketShiftDraft>|undefined;
    let draftSavedAt=savedDraft?.updated_at||"";
    try{
      const localDraft=JSON.parse(localStorage.getItem(`ticket-shift-draft:${shiftId}`)||"null") as {payload?:Partial<TicketShiftDraft>;savedAt?:string}|null;
      if(localDraft?.payload&&(!draftPayload||String(localDraft.savedAt||"")>draftSavedAt)){draftPayload=localDraft.payload;draftSavedAt=String(localDraft.savedAt||"");}
    }catch{}
    try{
      const offlineDraft=await getOfflineTicketDraft(shiftId);
      if(offlineDraft?.payload&&(!draftPayload||offlineDraft.savedAt>draftSavedAt)){
        draftPayload=offlineDraft.payload as Partial<TicketShiftDraft>;
        draftSavedAt=offlineDraft.savedAt;
      }
    }catch{}
    if(Array.isArray(draftPayload?.rows)){
      restoredRows=draftPayload.rows.filter((row:any)=>row&&typeof row.id==="string"&&Array.isArray(row.codes)).map((row:any)=>({
        id:row.id,codes:[0,1,2,3].map(index=>String(row.codes[index]||"")),quantities:row.quantities&&typeof row.quantities==="object"?row.quantities:{},price:Number(row.price||10000),gift:String(row.gift||""),
        ...(row.promotionRole?{promotionRole:row.promotionRole}:{}),...(row.promotionGroupId?{promotionGroupId:row.promotionGroupId}:{}),...(normalizeTicketRowColor(row.rowColor)?{rowColor:normalizeTicketRowColor(row.rowColor)}:{}),
      }));
      if(draftPayload.allowances&&typeof draftPayload.allowances==="object")setAllowances(draftPayload.allowances);
      if(typeof draftPayload.kinhTrung==="string")setKinhTrung(draftPayload.kinhTrung);
      const savedExtraRoles=savedDraft?.extra_roles&&typeof savedDraft.extra_roles==="object"?savedDraft.extra_roles:null;
      if(savedExtraRoles&&(savedExtraRoles.organ||savedExtraRoles.ticketChecker))setTicketExtraRoles({organ:String(savedExtraRoles.organ||""),ticketChecker:String(savedExtraRoles.ticketChecker||"")});
      else if(draftPayload.extraRoles&&typeof draftPayload.extraRoles==="object")setTicketExtraRoles({organ:String(draftPayload.extraRoles.organ||""),ticketChecker:String(draftPayload.extraRoles.ticketChecker||"")});
      if(draftPayload.caseMode)setCaseMode(draftPayload.caseMode);
      ticketLastServerDraftAtRef.current=draftSavedAt;
      ticketLocalDirtyRef.current=false;
      setTicketDraftSavedAt(draftSavedAt);
      setTicketDraftStatus("saved");
    } else if(draftError) setMessage(`Không thể tải bản nháp File Vé: ${draftError.message}`);
    setTicketRows(restoredRows.length?restoredRows:Array.from({length:12},blankTicketRow));
    ticketDraftReadyShiftRef.current=shiftId;
    setTicketLoading(false);
  }

  useEffect(()=>{
    if(!session||!profile||panel!=="tickets"||!activeShift||ticketLoading||ticketDraftReadyShiftRef.current===activeShift.id)return;
    void loadTicketWorkspace(activeShift.id,activeShift.venue_id);
  },[session?.user.id,profile?.business_id,panel,activeShift?.id,activeShift?.venue_id]);

  async function refreshUsableTicketInventory(shiftId:number,venueId:number) {
    const businessId=Number(profile?.business_id||0);
    if(!businessId||!venueId)return {catalog:ticketInventoryCatalog,available:ticketInventory};
    const {data,error}=await supabase.from("ticket_inventory")
      .select("id,code,handover_quantity,gift_value")
      .eq("business_id",businessId).eq("venue_id",venueId).eq("status","active").order("code");
    if(error)return {catalog:ticketInventoryCatalog,available:ticketInventory};
    const catalog=(data||[]) as TicketItem[];
    const ids=catalog.map(item=>item.id);
    const {data:reserved}=ids.length
      ? await supabase.from("ticket_round_codes").select("ticket_inventory_id,round:round_id!inner(status,shift_id,reconciliation_confirmed_at,reconciliation_variance)").in("ticket_inventory_id",ids)
      : {data:[] as any[]};
    const reservedByOtherShift=new Set((reserved||[]).filter((row:any)=>{
      const round=Array.isArray(row.round)?row.round[0]:row.round;
      const stillAwaiting=!round||round.status!=="verified"||(!round.reconciliation_confirmed_at&&Number(round.reconciliation_variance||0)!==0);
      return Number(round?.shift_id)!==shiftId&&stillAwaiting;
    }).map((row:any)=>Number(row.ticket_inventory_id)));
    const available=catalog.filter(item=>!reservedByOtherShift.has(item.id));
    setTicketInventoryCatalog(catalog);
    setTicketInventory(available);
    return {catalog,available};
  }
  async function saveTicketDraft() {
    const job=ticketDraftLatestRef.current;
    if(!job||ticketReadOnly||!activeShift||activeShift.id!==job.shiftId||ticketDraftReadyShiftRef.current!==job.shiftId)return;
    const localSavedAt=new Date().toISOString();
    await putOfflineTicketDraft({shiftId:job.shiftId,businessId:job.businessId,venueId:job.venueId,payload:job.payload,updatedBy:job.updatedBy,savedAt:localSavedAt,pending:true}).catch(()=>undefined);
    if(typeof navigator!=="undefined"&&!navigator.onLine){setIsOnline(false);setTicketDraftStatus("offline");return;}
    if(ticketDraftInFlightRef.current){ticketDraftQueuedRef.current=true;return;}
    ticketDraftInFlightRef.current=true;
    ticketDraftQueuedRef.current=false;
    setTicketDraftStatus("saving");
    try{
      const savedAt=new Date().toISOString();
      const {error}=await supabase.from("ticket_shift_drafts").upsert({
        shift_id:job.shiftId,
        business_id:job.businessId,
        venue_id:job.venueId,
        payload:job.payload,
        extra_roles:job.payload.extraRoles||{organ:"",ticketChecker:""},
        updated_by:job.updatedBy||null,
        updated_at:savedAt,
      },{onConflict:"shift_id"});
      if(error)throw error;
      await markOfflineTicketDraftSynced(job.shiftId,savedAt).catch(()=>undefined);
      if(ticketDraftLatestRef.current?.revision===job.revision){
        ticketLastServerDraftAtRef.current=savedAt;
        ticketLocalDirtyRef.current=false;
        setTicketDraftSavedAt(savedAt);
        setTicketDraftStatus("saved");
      }
    }catch{
      setTicketDraftStatus("offline");
    }finally{
      ticketDraftInFlightRef.current=false;
      if(ticketDraftQueuedRef.current||ticketDraftLatestRef.current?.revision!==job.revision){
        ticketDraftQueuedRef.current=false;
        void saveTicketDraft();
      }
    }
  }
  async function saveTicketRows() {
    if (!activeShift || !profile || ticketReadOnly) return false;
    if(ticketRowsSaveInFlightRef.current){
      setMessage("File Vé đang được lưu. Vui lòng chờ hoàn tất.");
      return false;
    }
    ticketRowsSaveInFlightRef.current=true;
    try {
      const enteredCodes=ticketRows.flatMap(row=>row.codes).filter(Boolean);
      let catalog=ticketInventoryCatalog;
      let available=ticketInventory;
      if(enteredCodes.some(code=>!resolveTicketItem(code,catalog))){
        const refreshed=await refreshUsableTicketInventory(activeShift.id,activeShift.venue_id);
        catalog=refreshed.catalog;available=refreshed.available;
      }
      const missingCode=enteredCodes.find(code=>!resolveTicketItem(code,catalog));
      if(missingCode){setMessage(`Mã ${missingCode} không tồn tại trong kho vé của ${selectedVenueName}.`);return false;}
      const reservedCode=enteredCodes.find(code=>!resolveTicketItem(code,available));
      if(reservedCode){setMessage(`Mã ${reservedCode} đang chờ đối chiếu từ ca trước.`);return false;}
      const duplicateCode=enteredCodes.find((code,index)=>enteredCodes.findIndex(other=>ticketCodeKey(other)===ticketCodeKey(code))!==index);
      if(duplicateCode){
        const locations=ticketRows.flatMap((row,rowIndex)=>row.codes.map((code,slot)=>ticketCodeKey(code)===ticketCodeKey(duplicateCode)?`Vòng ${rowIndex+1} · Mã vé ${slot+1}`:"").filter(Boolean));
        setMessage(`Mã ${duplicateCode} bị trùng tại ${locations.join(" và ")}. Vui lòng sửa đúng các ô màu đỏ trước khi lưu hoặc đóng ca.`);
        return false;
      }
      // Một vòng đã có mã vé là dữ liệu thật và phải được lưu, kể cả tổng số bán bằng 0.
      const usedRows=ticketRows.map((row,index)=>({row,index})).filter(({row})=>ticketRowHasCode(row));
      const rowsToSave=usedRows.map(({row,index})=>{
        const total=ticketTotals(row);
        const codes=row.codes.map((code,slot)=>({slot:slot+1,ticket_inventory_id:resolveTicketItem(code,available)?.id})).filter(item=>item.ticket_inventory_id);
        const sales=shiftStaff.map(person=>({employee_id:person.id,quantity:Number(row.quantities[person.id]||0)})).filter(item=>item.quantity>0);
        return {client_id:row.id,sequence_no:index+1,ticket_price:row.promotionRole==="gift"?0:row.price,opening_quantity:total.opening,sold_quantity:total.sold,gift_value:row.promotionRole==="gift"?0:Number(row.gift||0),codes,sales};
      });
      // Lưu cả File Vé trong một giao dịch: nếu bị gián đoạn, không vòng nào bị để lại ở số thứ tự tạm.
      const {error:saveError}=await supabase.rpc("save_ticket_shift_rows",{
        p_shift_id:activeShift.id,
        p_rows:rowsToSave,
      });
      if(saveError){setMessage(`Không thể lưu File Vé: ${saveError.message}`);return false;}
      await syncLotoRevenue();
      return true;
    } finally {
      ticketRowsSaveInFlightRef.current=false;
    }
  }
  async function syncLotoRevenue() {
    if (!activeShift || !session || ticketReadOnly) return;
    // File Vé chỉ phát sinh số liệu khi có ít nhất một mã vé thật.
    // Dòng trống không được tạo doanh thu, tặng phẩm, CASE hay dữ liệu báo cáo.
    if (!ticketRows.some(ticketRowHasCode)) return;
    const workDay=activeShift.performance_date?new Date(activeShift.performance_date+"T00:00:00").getDay():-1;
    // Giao diện luôn dùng CASE cuối tuần khi ngày làm việc rơi vào Thứ Bảy/Chủ Nhật,
    // kể cả ca cũ đang lưu case_mode="regular". Đồng bộ cùng quy tắc xuống máy chủ để
    // doanh thu không bị trừ CASE ngày thường trong khi tổng trên File Vé là CASE cuối tuần.
    const persistedCaseMode=caseMode==="regular"&&(workDay===0||workDay===6)?"weekend":caseMode;
    const { data,error } = await supabase.rpc("sync_loto_shift_revenue",{
      p_shift_id:activeShift.id,
      p_case_mode:persistedCaseMode,
      p_allowances:Object.fromEntries(shiftStaff.map(person=>[String(person.id),Number(allowances[person.id]||0)])),
      p_kinh_trung:Number(kinhTrung||0),
      p_extra_staff:{organ:Number(ticketExtraRoles.organ)||null,ticket_checker:Number(ticketExtraRoles.ticketChecker)||null},
    });
    if (error) { setMessage(error.message); return; }
    const financeEntryId=Number(data?.[0]?.finance_entry_id||0);
    if (financeEntryId && appsScriptSyncUrl) {
      void fetch(appsScriptSyncUrl,{
        method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},
        body:JSON.stringify({action:"syncFinanceRevenue",accessToken:session.access_token,publishableKey:supabaseKey,financeEntryId}),
      });
    }
    if (panel === "finance") await loadFinance(financeDate);
  }


  useEffect(() => {
    if(!activeShift||!profile||panel!=="tickets"||ticketReadOnly||ticketDraftReadyShiftRef.current!==activeShift.id)return;
    if(ticketSkipDraftPersistRef.current){ticketSkipDraftPersistRef.current=false;return;}
    const payload:TicketShiftDraft={rows:ticketRows,allowances,kinhTrung,extraRoles:ticketExtraRoles,caseMode,clientId:ticketDraftClientId()};
    ticketLocalDirtyRef.current=true;
    const savedAt=new Date().toISOString();
    try{localStorage.setItem(`ticket-shift-draft:${activeShift.id}`,JSON.stringify({payload,savedAt}));}catch{}    void putOfflineTicketDraft({shiftId:activeShift.id,businessId:profile.business_id,venueId:activeShift.venue_id,payload,updatedBy:session?.user.id||"",savedAt,pending:true}).catch(()=>undefined);
    const revision=++ticketDraftRevisionRef.current;
    ticketDraftLatestRef.current={shiftId:activeShift.id,businessId:profile.business_id,venueId:activeShift.venue_id,payload,updatedBy:session?.user.id||"",revision};
    setTicketDraftStatus("saving");
    const timer=setTimeout(()=>{void saveTicketDraft();},600);
    return()=>clearTimeout(timer);
  },[ticketRows,allowances,kinhTrung,ticketExtraRoles,caseMode,activeShift?.id,activeShift?.venue_id,panel,ticketReadOnly,profile?.business_id,session?.user.id]);

  useEffect(() => {
    if (!activeShift || panel !== "tickets" || ticketReadOnly) return;
    const timer=setTimeout(() => { void syncLotoRevenue(); },450);
    return () => clearTimeout(timer);
  }, [allowances, kinhTrung, ticketExtraRoles, caseMode, activeShift?.id, panel]);

  async function loadPendingTicketReportShifts(selectedVenueId=reportVenueId,selectFirst=true,varianceOnly=reportVarianceOnly,historyMode=reportHistoryMode,historyDate=reportHistoryDate) {
    const venueScope=Number(selectedVenueId)||0;
    const allVenues=selectedVenueId==="all"&&profile?.role==="owner";
    if(!profile||(!venueScope&&!allVenues)){setPendingReportShifts([]);setReportShiftId("");setReportRounds([]);return;}
    setReportLoading(true);setMessage("");
    let query=supabase.from("shifts")
      .select("id,business_id,name,venue_id,opened_at,opened_by,closed_by,closed_at,performance_date,kinh_trung_amount,status,ticket_rounds(id,status,opening_quantity,sold_quantity,reconciliation_confirmed_at,reconciliation_variance,ticket_round_codes(actual_remaining,defective_quantity,cancellation_status))")
      .eq("business_id",profile.business_id);
    if(!allVenues)query=query.eq("venue_id",venueScope);
    if(historyMode&&historyDate)query=query.eq("performance_date",historyDate);
    const {data,error}=await query.order("performance_date",{ascending:false}).order("opened_at",{ascending:false});
    if(error){setPendingReportShifts([]);setReportRounds([]);setReportLoading(false);setMessage("Không thể tải danh sách Báo Cáo Vé.");return;}
    const shifts=((data||[]) as any[]).flatMap(shift=>{
      const rounds=(shift.ticket_rounds||[]).filter((round:any)=>{const result=ticketRoundReconciliation({...round,ticket_round_codes:round.ticket_round_codes||[]} as ReportRound);return result.activeCodes.length>0&&result.hasSale;});
      const scopedRounds=varianceOnly?rounds.filter((round:any)=>ticketRoundReconciliation({...round,ticket_round_codes:round.ticket_round_codes||[]} as ReportRound).hasOutstandingVariance):rounds;
      if(!scopedRounds.length)return [];
      if(!historyMode&&!varianceOnly&&rounds.every((round:any)=>round.status==="verified"&&!ticketRoundReconciliation({...round,ticket_round_codes:round.ticket_round_codes||[]} as ReportRound).hasOutstandingVariance))return [];
      const venueName=venues.find(venue=>venue.id===Number(shift.venue_id))?.name||"Sân Khấu";
      return [{...shift,name:`${venueName} · ${shift.name}`,round_count:scopedRounds.length,verified_count:scopedRounds.filter((round:any)=>round.status==="verified").length,report_started:scopedRounds.some((round:any)=>round.status==="verified"||(round.ticket_round_codes||[]).some((code:any)=>code.cancellation_status!=="approved"&&code.actual_remaining!==null))}] as PendingReportShift[];
    });
    setPendingReportShifts(shifts);
    const currentStillVisible=shifts.some(shift=>String(shift.id)===reportShiftId);
    const nextShiftId=currentStillVisible?reportShiftId:(selectFirst&&shifts[0]?String(shifts[0].id):"");
    setReportShiftId(nextShiftId);
    if(nextShiftId)await loadTicketReport(nextShiftId);else{setReportRounds([]);setReportLoading(false);}
  }
  async function loadTicketReport(selectedShiftId=reportShiftId) {
    setReportLoading(true); setMessage("");
    const shiftScope=Number(selectedShiftId)||0;
    if(!shiftScope){setReportRounds([]);setReportLoading(false);return;}
    const { data,error }=await supabase.from("ticket_rounds").select("id,client_id,sequence_no,opening_quantity,sold_quantity,ticket_price,gift_value,status,reconciliation_confirmed_at,reconciliation_confirmed_by,reconciliation_variance,ticket_round_codes(slot,ticket_inventory_id,actual_remaining,defective_quantity,cancellation_status,ticket_inventory:ticket_inventory_id(code))").eq("shift_id",shiftScope).order("sequence_no");
    if (error) setMessage("Không thể tải Báo Cáo Vé.");
    const rounds=((data||[]) as unknown as ReportRound[])
      .filter(round=>round.ticket_round_codes.length>0)
      .map((round,index)=>({...round,sequence_no:index+1}));
    setReportRounds(rounds);
    setExpandedDefectiveCodes(Object.fromEntries(rounds.flatMap(round=>round.ticket_round_codes.filter(code=>Number(code.defective_quantity||0)>0).map(code=>[`${round.id}-${code.slot}`,true]))));
    setReportLoading(false);
  }

  function refreshTicketReportAfterRemoteSave(){
    if(panel!=="ticketReport")return;
    reportRemoteRefreshPendingRef.current=false;
    void loadPendingTicketReportShifts(reportVenueId,false,reportVarianceOnly,reportHistoryMode,reportHistoryDate);
  }

  function enqueueTicketReportDraftSave(roundId:number){
    const previous=reportSaveChainsRef.current.get(roundId)||Promise.resolve(true);
    const save=previous.catch(()=>false).then(async()=>{
      const round=reportRoundsRef.current.find(item=>item.id===roundId);
      if(!round||round.status==="verified")return true;
      return persistTicketReportRound(round,true);
    });
    reportSaveChainsRef.current.set(roundId,save);
    return save;
  }

  function queueTicketReportDraftSave(roundId:number){
    const existing=reportSaveTimersRef.current.get(roundId);
    if(existing)window.clearTimeout(existing);
    const revision=++reportDraftRevisionRef.current;
    reportLocalDirtyRef.current=true;
    const timer=window.setTimeout(()=>{
      reportSaveTimersRef.current.delete(roundId);
      void enqueueTicketReportDraftSave(roundId).then(saved=>{
        if(saved&&revision===reportDraftRevisionRef.current){
          reportLocalDirtyRef.current=false;
          if(reportRemoteRefreshPendingRef.current)refreshTicketReportAfterRemoteSave();
        }
      });
    },650);
    reportSaveTimersRef.current.set(roundId,timer);
  }

  async function flushTicketReportDraftSave(roundId:number){
    const pendingTimer=reportSaveTimersRef.current.get(roundId);
    if(pendingTimer){window.clearTimeout(pendingTimer);reportSaveTimersRef.current.delete(roundId);}
    const revision=++reportDraftRevisionRef.current;
    reportLocalDirtyRef.current=true;
    const saved=await enqueueTicketReportDraftSave(roundId);
    if(saved&&revision===reportDraftRevisionRef.current){
      reportLocalDirtyRef.current=false;
      if(reportRemoteRefreshPendingRef.current)refreshTicketReportAfterRemoteSave();
    }
    return saved;
  }

  async function openTicketReport() {
    const defaultVenue=profile?.role==="manager"?(profile.venue_id||activeShift?.venue_id):(activeShift?.venue_id||Number(venueId)||profile?.venue_id||venues[0]?.id);
    const selectedVenue=profile?.role==="owner"?"all":(reportVenueId||String(defaultVenue||""));
    // Báo Cáo Vé luôn thuộc Loto. Ghi ngay cả trạng thái hiển thị lẫn phân hệ
    // trước khi render để một hashchange nền không thể trả người dùng về Kios.
    visiblePanelRef.current="ticketReport";
    setReportVarianceOnly(false);setActiveMenu(null);setModuleSection("Loto");setPanel("ticketReport");setReportVenueId(selectedVenue);
    // Mở ngay phiên đầu tiên đang chờ. Không để trang Báo Cáo Vé trống khi
    // Chủ Sở Hữu đang xem phạm vi tất cả sân khấu.
    await loadPendingTicketReportShifts(selectedVenue,true,false);
  }

  async function inspectOpenShift(shift:Shift){
    rememberTicketShift(shift);setVenueId(String(shift.venue_id));setShiftWorkDate(shift.performance_date||localDateValue());
    await loadTicketWorkspace(shift.id,shift.venue_id);setModuleSection("Loto");setPanel("tickets");
  }

  function updateReportCode(roundId:number,slot:number,field:"actual_remaining"|"defective_quantity",value:string) {
    if (reportRounds.find(round=>round.id===roundId)?.status==="verified") return;
    const numberValue=value==="" ? null : Math.max(0,Number(value));
    setReportRounds(current => current.map(round => round.id===roundId ? {...round,ticket_round_codes:round.ticket_round_codes.map(code => code.slot===slot ? {...code,[field]:numberValue} : code)} : round));
    queueTicketReportDraftSave(roundId);
  }

  async function persistTicketReportRound(round:ReportRound,quiet=false) {
    const results=await Promise.all(round.ticket_round_codes.map(code=>supabase.from("ticket_round_codes")
      .update({actual_remaining:code.actual_remaining,defective_quantity:code.defective_quantity})
      .eq("round_id",round.id).eq("slot",code.slot)));
    const failure=results.find(result=>result.error)?.error;
    if(failure){if(!quiet)setMessage("Không thể lưu tồn thực tế: "+failure.message);return false;}
    return true;
  }

  async function finalizeTicketReport(roundId:number) {
    const round=reportRounds.find(item=>item.id===roundId);
    if (!round || round.ticket_round_codes.some(code=>code.actual_remaining===null)) { setMessage("Phải nhập tồn thực tế cho tất cả mã vé trước khi hoàn tất báo cáo."); return; }
    if(!await flushTicketReportDraftSave(roundId))return;
    const { data,error }=await supabase.rpc("finalize_ticket_report",{p_round_id:roundId});
    if (error) { setMessage(error.message); return; }
    const inventoryIds=(data?.updates||[]).map((item:{ticket_inventory_id:number})=>item.ticket_inventory_id);
    const finalizedVenueId=Number(data?.venue_id||reportVenueId||0);
    if (session?.access_token && inventoryIds.length) {
      if (appsScriptSyncUrl) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncTicketInventory",accessToken:session.access_token,publishableKey:supabaseKey,venueId:finalizedVenueId,inventoryIds})});
    }
    setMessage("Đã hoàn tất báo cáo vòng. Kho vé chỉ cập nhật Tồn Thực Tế; Vé Lỗi chỉ dùng để đối chiếu và không cộng vào tồn kho.");
    await loadTicketReport();
    await loadPendingTicketReportShifts(reportVenueId,false);
    if (activeShift) await loadTicketWorkspace(activeShift.id);
  }

  async function finalizeAllTicketReports() {
    const reportableRounds=reportRounds.filter(round=>{const current=ticketRoundReconciliation(round);return current.activeCodes.length>0&&current.hasSale;});
    const pendingRounds=reportableRounds.filter(round=>round.status!=="verified");
    if (!pendingRounds.length) { setMessage("Toàn bộ báo cáo vé của ngày này đã hoàn tất."); return; }
    if (pendingRounds.some(round=>!ticketRoundReconciliation(round).hasCompleteEntry)) {
      setMessage("Phải nhập Tồn Thực Tế cho tất cả mã vé của tất cả vòng trước khi hoàn tất báo cáo.");
      return;
    }
    setSaving(true); setMessage("");
    const inventoryIds:number[]=[];
    let finalizedVenueId=Number(reportVenueId)||0;
    for (const round of pendingRounds) {
      if(!await flushTicketReportDraftSave(round.id)){
        setSaving(false);
        return;
      }
      const {data,error}=await supabase.rpc("finalize_ticket_report",{p_round_id:round.id});
      if (error) {
        setSaving(false);
        setMessage(`Không thể hoàn tất Vòng ${round.sequence_no}: ${error.message}`);
        await loadTicketReport();
        return;
      }
      finalizedVenueId=Number(data?.venue_id||finalizedVenueId);
      inventoryIds.push(...(data?.updates||[]).map((item:{ticket_inventory_id:number})=>item.ticket_inventory_id));
    }
    if (session?.access_token&&inventoryIds.length&&appsScriptSyncUrl) {
      void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncTicketInventory",accessToken:session.access_token,publishableKey:supabaseKey,venueId:finalizedVenueId,inventoryIds:[...new Set(inventoryIds)]})});
    }
    setSaving(false);
    setMessage("Đã hoàn tất toàn bộ báo cáo vé. Kho chỉ cập nhật Tồn Thực Tế; Vé Lỗi không cộng vào tồn kho.");
    await loadTicketReport();
    await loadPendingTicketReportShifts(reportVenueId,false);
    if (activeShift) await loadTicketWorkspace(activeShift.id);
  }

  async function confirmTicketVariance(roundId:number) {
    if(profile?.role!=="owner"){setMessage("Chỉ chủ sở hữu được xác nhận sai lệch vé.");return;}
    const round=reportRounds.find(item=>item.id===roundId);
    const reconciliation=round?ticketRoundReconciliation(round):null;
    if(!round||!reconciliation?.hasOutstandingVariance){setMessage("Vòng vé không còn vé lỗi, thiếu hoặc dư cần xác nhận.");return;}
    const reviewParts:string[]=[];
    if(reconciliation.variance>0)reviewParts.push("thiếu "+reconciliation.variance+" vé");
    if(reconciliation.variance<0)reviewParts.push("dư "+Math.abs(reconciliation.variance)+" vé");
    if(reconciliation.defectiveTickets>0)reviewParts.push(reconciliation.defectiveTickets+" vé lỗi");
    const varianceLabel=reviewParts.join(" · ");
    setConfirmingVarianceRoundId(roundId);setMessage("");
    const {error}=await supabase.rpc("confirm_ticket_reconciliation",{p_round_id:roundId});
    setConfirmingVarianceRoundId(null);
    if(error){setMessage(error.message);return;}
    // Không dùng hộp thoại cảnh báo của trình duyệt: trạng thái đã xác nhận
    // sẽ hiển thị trực tiếp bằng nhãn xanh ngay tại vòng vé.
    await loadTicketReport();
    await loadPendingTicketReportShifts(reportVenueId,false,reportVarianceOnly,reportHistoryMode,reportHistoryDate);
    await loadOverviewTicketVariances();
    if(activeShift)await loadTicketWorkspace(activeShift.id,activeShift.venue_id);
  }
  async function approveCancellation(roundId:number,slot:number) {
    const { error }=await supabase.rpc("approve_ticket_cancellation",{p_round_id:roundId,p_slot:slot});
    if(error){setMessage(error.message);return;}
    setMessage("Đã duyệt hủy mã vé, loại khỏi kho và loại khỏi toàn bộ báo cáo không khớp của đúng sân khấu.");
    await loadPendingTicketReportShifts(reportVenueId,true,showTicketVarianceOnly);
    await loadOverviewTicketVariances();
    if(activeShift)await loadTicketWorkspace(activeShift.id,activeShift.venue_id);
  }

  const revenueCategories = [["loto","Loto"],["game","Trò Chơi"],["water","Quán Nước"],["kiosk","Kios"],["other","Khác"]] as const;
  const expenseCategories = [["loto","Loto"],["game","Trò Chơi"],["water","Quán Nước"],["payroll","Lương Nhân Viên"]] as const;
  const financeCategoryLabel = (value:string) => value==="all"?"Tổng":[...revenueCategories,...expenseCategories].find(([key]) => key === value)?.[1] || value;
  const menuFinanceCategory = (item:string) => item.includes("Trò Chơi") ? "game" : item.includes("Quán Nước") ? "water" : item.includes("Kios") ? "kiosk" : "loto";
  const sectionForCategory = (category:string) => category === "all" ? "Tổng Quan" : category === "game" ? "Trò Chơi" : category === "water" ? "Quán Nước" : category === "kiosk" ? "Kios" : category === "payroll" ? "Nhân Sự Tư Hậu" : "Loto";

  function openModule(name:string) {
    if(profile?.role==="employee"){
      setMessage("");
      setModuleSection("Nhân Sự Tư Hậu");setPersonnelTab("mySchedule");setPanel("staffManagement");setActiveMenu(null);return;
    }
    // Mỗi phân hệ Thu/Chi hoạt động độc lập với File Vé. Xóa thông báo cũ
    // (ví dụ cảnh báo yêu cầu mở ca của một màn khác) khi chuyển phân hệ.
    setMessage("");
    setModuleSection(name);
    setPanel("module");
    setActiveMenu(null);
  }

  async function loadGameReport() {
    if (!activeShift) { setMessage("Phải mở ca làm việc trước khi nhập báo cáo Trò Chơi."); return; }
    setGameReady(false);
    const {data,error}=await supabase.from("game_shift_reports")
      .select("id,shift_id,report_date,ticket_10k_quantity,ticket_20k_quantity,inflatable_20k_quantity,nlh_30k_quantity,total_amount")
      .eq("shift_id",activeShift.id).maybeSingle();
    if (error) { setMessage(error.message); return; }
    const report=data as GameReport|null;
    const quantities=Object.fromEntries(gameProducts.map(item=>[item.key,report ? String(Number(report[item.key]||0)||"") : ""])) as Record<GameQuantityKey,string>;
    setGameQuantities(quantities);
    setGameAmounts(Object.fromEntries(gameReportProducts.map(item=>[item.key,quantities[item.key] ? String(Number(quantities[item.key])*item.price) : ""])) as Record<GameQuantityKey,string>);
    setGameReportDate(report?.report_date || activeShift?.performance_date || "");
    setGameTouched(false);
    setGameReady(true);
  }

  async function openGameReport() {
    if (!activeShift) { setMessage("Phải mở ca làm việc trước khi nhập báo cáo Trò Chơi."); return; }
    setActiveMenu(null); setModuleSection("Trò Chơi"); setPanel("gameReport");
    await loadGameReport();
  }

  async function updateShiftWorkDate(value:string) {
    if (!activeShift || !value || value===activeShift.performance_date) return;
    const {data,error}=await supabase.rpc("set_shift_work_date",{p_shift_id:activeShift.id,p_work_date:value});
    if (error) { setMessage(error.message); return; }
    setActiveShift(current=>current?{...current,performance_date:value}:current);
    setShiftWorkDate(value); setFinanceDate(value); setGameReportDate(value); setKioskPaidDate(value);
    if (session?.access_token && appsScriptSyncUrl) {
      const ids=(data?.finance_entry_ids||[]) as number[];
      ids.forEach(financeEntryId=>void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncFinanceRevenue",accessToken:session.access_token,publishableKey:supabaseKey,financeEntryId})}));
      if (data?.game_report_id) {
        const {data:gameFinance}=await supabase.from("finance_entries").select("id").eq("shift_id",activeShift.id).eq("category","game").maybeSingle();
        if (gameFinance?.id) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncGameReport",accessToken:session.access_token,publishableKey:supabaseKey,reportId:data.game_report_id,financeEntryId:gameFinance.id})});
      }
    }
    setMessage("Đã cập nhật Ngày Làm Việc cho toàn bộ ca và các báo cáo liên kết.");
  }

  function updateGameQuantity(key:GameQuantityKey,value:string) {
    const clean=value.replace(/\D/g,"");
    const product=gameReportProducts.find(item=>item.key===key)!;
    setGameQuantities(current=>({...current,[key]:clean}));
    setGameAmounts(current=>({...current,[key]:clean ? String(Number(clean)*product.price) : ""}));
    setGameTouched(true);
  }

  function updateGameAmount(key:GameQuantityKey,value:string) {
    const clean=value.replace(/\D/g,"");
    const product=gameReportProducts.find(item=>item.key===key)!;
    setGameAmounts(current=>({...current,[key]:clean}));
    setGameQuantities(current=>({...current,[key]:clean && Number(clean)%product.price===0 ? String(Number(clean)/product.price) : ""}));
    setGameTouched(true);
  }

  async function saveGameReport() {
    if (!activeShift || !gameReady || !gameAmountsValid || !gameTouched || gameSaveLockRef.current) return;
    gameSaveLockRef.current=true;
    setGameSaving(true);
    try {
      const {data,error}=await supabase.rpc("save_game_shift_report",{
        p_shift_id:activeShift.id,
        p_report_date:gameReportDate,
        p_ticket_10k:Number(gameQuantities.ticket_10k_quantity||0),
        p_ticket_20k:Number(gameQuantities.ticket_20k_quantity||0),
        p_inflatable_20k:Number(gameQuantities.inflatable_20k_quantity||0),
        p_nlh_30k:Number(gameQuantities.nlh_30k_quantity||0),
      });
      if (error) { setMessage(error.message); return; }
      setGameTouched(false);
      setMessage("Đã cập nhật doanh thu và trừ đúng số vé bán trong kho. Báo cáo này đã được khóa chống bấm lặp.");
      const result=data?.[0];
      if (session?.access_token && appsScriptSyncUrl && result?.finance_entry_id) {
        void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncGameReport",accessToken:session.access_token,publishableKey:supabaseKey,reportId:result.report_id,financeEntryId:result.finance_entry_id})});
      }
    } finally {
      setGameSaving(false);
      gameSaveLockRef.current=false;
    }
  }

  async function loadKioskConfigs(venueOverride?:string|number) {
    const selected=String(venueOverride||kioskVenueId||"");
    if (!selected) { setKioskConfigs([]); return; }
    setKioskConfigLoading(true);
    const {data,error}=await supabase.from("kiosks")
      .select("id,business_id,venue_id,kiosk_code,kiosk_name,default_rent,default_service_fee,default_garbage_fee,default_security_fee,is_active")
      .eq("venue_id",Number(selected)).order("is_active",{ascending:false}).order("kiosk_name");
    setKioskConfigLoading(false);
    if (error) { setMessage(error.message); return; }
    setKioskConfigs((data||[]) as KioskConfig[]);
  }

  function editKioskConfig(item:KioskConfig) {
    setKioskEditingId(item.id);
    setKioskConfigDraft({code:item.kiosk_code,name:item.kiosk_name,rent:String(item.default_rent||""),serviceFee:String(item.default_service_fee||""),garbageFee:String(item.default_garbage_fee||""),securityFee:String(item.default_security_fee||"")});
  }

  function resetKioskConfigDraft() {
    setKioskEditingId(null);
    setKioskConfigDraft({code:"",name:"",rent:"",serviceFee:"",garbageFee:"",securityFee:""});
  }

  async function saveKioskConfig() {
    const code=kioskConfigDraft.code.trim().toUpperCase().replace(/\s+/g,"_");
    const name=kioskConfigDraft.name.trim();
    if (!kioskVenueId) { setMessage("Vui lòng chọn sân khấu trước khi cấu hình Kios."); return; }
    if (!code||!name) { setMessage("Vui lòng nhập đầy đủ mã và tên Kios."); return; }
    if (!profile?.business_id||!session?.user.id) { setMessage("Phiên đăng nhập chưa sẵn sàng."); return; }
    setKioskConfigSaving(true);
    const values={business_id:profile.business_id,venue_id:Number(kioskVenueId),kiosk_code:code,kiosk_name:name,default_rent:kioskNumber(kioskConfigDraft.rent),default_service_fee:kioskNumber(kioskConfigDraft.serviceFee),default_garbage_fee:kioskNumber(kioskConfigDraft.garbageFee),default_security_fee:kioskNumber(kioskConfigDraft.securityFee),updated_at:new Date().toISOString()};
    const result=kioskEditingId
      ? await supabase.from("kiosks").update(values).eq("id",kioskEditingId).eq("venue_id",Number(kioskVenueId))
      : await supabase.from("kiosks").insert({...values,created_by:session.user.id,is_active:true});
    setKioskConfigSaving(false);
    if (result.error) { setMessage(result.error.code==="23505"?"Mã Kios đã tồn tại trong sân khấu này.":result.error.message); return; }
    const successMessage=kioskEditingId?"Đã cập nhật cấu hình Kios.":"Đã thêm Kios mới đúng sân khấu.";
    resetKioskConfigDraft();
    await Promise.all([loadKioskConfigs(kioskVenueId),loadKioskBills(kioskMonth,kioskVenueId)]);
    setMessage(successMessage);
  }

  async function toggleKioskConfig(item:KioskConfig) {
    if (!kioskVenueId||kioskConfigSaving) return;
    setKioskConfigSaving(true);
    const {error}=await supabase.from("kiosks").update({is_active:!item.is_active,updated_at:new Date().toISOString()}).eq("id",item.id).eq("venue_id",Number(kioskVenueId));
    setKioskConfigSaving(false);
    if (error) { setMessage(error.message); return; }
    await loadKioskConfigs(kioskVenueId);
    setMessage(item.is_active?"Đã ngừng hoạt động Kios. Dữ liệu lịch sử vẫn được giữ nguyên.":"Đã kích hoạt lại Kios.");
  }
  async function loadKioskBills(month=kioskMonth,venueOverride?:string|number) {
    const selectedKioskVenueId=String(venueOverride||kioskVenueId||"");
    if (!selectedKioskVenueId) { setMessage("Chưa có sân khấu làm việc để quản lý Thu Kios."); return; }
    setKioskSaving(true);
    setMessage("");
    const loadController=new AbortController();
    const loadTimeout=window.setTimeout(()=>loadController.abort(),8000);
    const queryKioskBills=()=>supabase.from("kiosk_monthly_bills")
      .select("id,kiosk_id,billing_month,rent_amount,base_rent_amount,rent_escalation_rate,rent_escalation_amount,electric_old,electric_new,electric_amount,water_old,water_new,water_amount,service_fee,garbage_fee,security_fee,surcharge,previous_debt,total_due,closing_date,due_date,payment_status,paid_date,paid_amount,note,kiosk:kiosk_id(kiosk_code,kiosk_name,default_rent,lease_start,lease_end,deposit_amount,rent_period_start,rent_period_end,escalation_rate,escalation_start,escalation_end)")
      .eq("venue_id",Number(selectedKioskVenueId)).eq("billing_month",`${month}-01`).order("due_date").abortSignal(loadController.signal);
    let {data,error}=await queryKioskBills();
    if (!error && !(data||[]).length) {
      const {error:prepareError}=await supabase.rpc("prepare_kiosk_month",{p_venue_id:Number(selectedKioskVenueId),p_billing_month:`${month}-01`}).abortSignal(loadController.signal);
      if (prepareError) error=prepareError;
      else ({data,error}=await queryKioskBills());
    }
    window.clearTimeout(loadTimeout);
    setKioskSaving(false);
    if (error) { setMessage(error.name==="AbortError"?"Máy chủ phản hồi quá lâu. Vui lòng bấm Thử Lại.":error.message); return; }
    const kioskOrder=["ANH_HAI","CHI_PHUONG","CHI_LY","NHA_GAME","ANH_KHANG"];
    const bills=((data||[]) as unknown as KioskBill[]).sort((a,b)=>kioskOrder.indexOf(a.kiosk?.kiosk_code||"")-kioskOrder.indexOf(b.kiosk?.kiosk_code||""));
    setKioskBills(bills);
    setKioskDrafts(Object.fromEntries(bills.map(bill=>[bill.id,{rent:String(bill.kiosk?.default_rent||bill.base_rent_amount||bill.rent_amount||""),electricOld:String(bill.electric_old||""),electricNew:String(bill.electric_new||bill.electric_old||""),waterOld:String(bill.water_old||""),waterNew:String(bill.water_new||bill.water_old||""),serviceFee:String(bill.service_fee||""),garbageFee:String(bill.garbage_fee||""),securityFee:String(bill.security_fee||""),surcharge:String(bill.surcharge||""),previousDebt:String(bill.previous_debt||""),note:bill.note||"",closingDate:displayVietnameseDate(bill.closing_date),dueDate:displayVietnameseDate(bill.due_date),leaseStart:bill.kiosk?.lease_start||"",leaseEnd:bill.kiosk?.lease_end||"",deposit:String(bill.kiosk?.deposit_amount||""),rentPeriodStart:bill.kiosk?.rent_period_start||"",rentPeriodEnd:bill.kiosk?.rent_period_end||"",escalationRate:String(bill.kiosk?.escalation_rate||""),escalationStart:bill.kiosk?.escalation_start||"",escalationEnd:bill.kiosk?.escalation_end||""}])));
    setKioskPaymentAmounts(Object.fromEntries(bills.map(bill=>[bill.id,bill.payment_status==="paid"&&bill.paid_amount!=null?String(bill.paid_amount):""])));
    if (session?.access_token && appsScriptSyncUrl && bills.length) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncKioskBills",accessToken:session.access_token,publishableKey:supabaseKey,billIds:bills.map(bill=>bill.id)})});
  }

  async function loadKioskApprovalHistory(month=kioskMonth,venueOverride?:string|number) {
    const selectedKioskVenueId=String(venueOverride||kioskVenueId||"");
    if (!selectedKioskVenueId) { setKioskApprovalHistory([]); return; }
    const monthStart=`${month}-01`;
    const nextMonthDate=new Date(`${monthStart}T00:00:00`);
    nextMonthDate.setMonth(nextMonthDate.getMonth()+1);
    const nextMonth=`${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth()+1).padStart(2,"0")}-01`;
    setKioskHistoryLoading(true);
    const {data,error}=await supabase.from("kiosk_payments")
      .select("id,venue_id,bill_id,paid_date,amount,created_by,created_at,bill:bill_id(billing_month,kiosk:kiosk_id(kiosk_code,kiosk_name))")
      .eq("venue_id",Number(selectedKioskVenueId)).gte("paid_date",monthStart).lt("paid_date",nextMonth)
      .order("created_at",{ascending:false});
    setKioskHistoryLoading(false);
    if (error) { setMessage(error.message); return; }
    setKioskApprovalHistory((data||[]) as unknown as KioskApprovalHistory[]);
  }
  async function openKioskRevenue() {
    const selectedKioskVenueId=String(kioskVenueId||financeVenueOverride||venueId||profile?.venue_id||venues[0]?.id||"");
    if (!selectedKioskVenueId) { setMessage("Chưa có sân khấu làm việc để quản lý Thu Kios."); return; }
    setKioskVenueId(selectedKioskVenueId);
    setMessage("");
    setKioskPaidDate(financeDate||localDateValue());
    setActiveMenu(null); setModuleSection("Kios"); setPanel("kioskRevenue");
    await Promise.all([loadKioskConfigs(selectedKioskVenueId),loadKioskBills(kioskMonth,selectedKioskVenueId),loadKioskApprovalHistory(kioskMonth,selectedKioskVenueId)]);
  }

  async function pullKiosksFromSheet(venueOverride?:string|number) {
    const selectedKioskVenueId=String(venueOverride||kioskVenueId||"");
    if (!selectedKioskVenueId || !session?.access_token || !appsScriptSyncUrl) return;
    setKioskSaving(true);
    try { await Promise.race([fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"pullKiosksFromSheet",accessToken:session.access_token,publishableKey:supabaseKey,venueId:Number(selectedKioskVenueId),billingMonth:kioskMonth})}).catch(()=>undefined),new Promise(resolve=>window.setTimeout(resolve,2500))]); }
    finally { setKioskSaving(false); }
  }

  function updateKioskDraft(billId:number,field:keyof KioskDraft,value:string) {
    const dateFields: Array<keyof KioskDraft>=["closingDate","dueDate","leaseStart","leaseEnd","rentPeriodStart","rentPeriodEnd","escalationStart","escalationEnd"];
    const cleaned=field==="note"||dateFields.includes(field)?value:field==="escalationRate"?value.replace(/[^\d.,]/g,"").replace(",","."):value.replace(/\D/g,"");
    setKioskDrafts(current=>({...current,[billId]:{...current[billId],[field]:cleaned}}));
  }

  async function saveKioskBill(bill:KioskBill,options:{reload?:boolean;silent?:boolean}={}) : Promise<number|null> {
    if (!kioskVenueId || !bill.kiosk) return null;
    const draft=kioskDrafts[bill.id];
    if (!draft) return null;
    const parsedClosingDate=parseVietnameseDate(draft.closingDate);
    const parsedDueDate=parseVietnameseDate(draft.dueDate);
    if ((draft.closingDate&&!parsedClosingDate)||(draft.dueDate&&!parsedDueDate)) { setMessage("Ngày Chốt và Hạn Đóng phải nhập theo dạng ngày/tháng/năm, ví dụ 31/08/2026."); return null; }
    const closingDate=parsedClosingDate||bill.closing_date;
    const dueDate=parsedDueDate||bill.due_date;
    const electricOld=kioskNumber(draft.electricOld);
    const electricNew=draft.electricNew.trim()?kioskNumber(draft.electricNew):electricOld;
    const waterOld=kioskNumber(draft.waterOld);
    const waterNew=draft.waterNew.trim()?kioskNumber(draft.waterNew):waterOld;
    if (electricNew<electricOld || waterNew<waterOld) { setMessage(`Chỉ số mới của ${bill.kiosk.kiosk_name} không được nhỏ hơn chỉ số cũ.`); return null; }
    setKioskSaving(true);
    const {data,error}=await supabase.rpc("save_kiosk_monthly_charge",{
      p_venue_id:Number(kioskVenueId),p_billing_month:`${kioskMonth}-01`,p_kiosk_code:bill.kiosk.kiosk_code,p_electric_old:electricOld,p_electric_new:electricNew,
      p_water_old:waterOld,p_water_new:waterNew,p_service_fee:kioskNumber(draft.serviceFee),
      p_garbage_fee:kioskNumber(draft.garbageFee),p_security_fee:kioskNumber(draft.securityFee),p_surcharge:kioskNumber(draft.surcharge),
      p_previous_debt:kioskNumber(draft.previousDebt),p_note:draft.note.trim()||null,
    });
    setKioskSaving(false);
    if (error) { setMessage(error.message); return null; }
    const billId=Number(data?.[0]?.bill_id||bill.id);
    const {error:dateError}=await supabase.rpc("update_kiosk_bill_dates",{p_bill_id:billId,p_closing_date:closingDate,p_due_date:dueDate});
    if (dateError) { setKioskSaving(false); setMessage(dateError.message); return null; }
    if (billId && session?.access_token && appsScriptSyncUrl) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncKioskBill",accessToken:session.access_token,publishableKey:supabaseKey,billId})});
    if (!options.silent) setMessage(`Đã lưu hóa đơn tháng của ${bill.kiosk.kiosk_name}. Điều khoản hợp đồng không bị thay đổi.`);
    if (options.reload!==false) await loadKioskBills();
    return billId;
  }

  async function saveKioskContract(bill:KioskBill) {
    if(!kioskVenueId||!bill.kiosk)return;
    const draft=kioskDrafts[bill.id];if(!draft)return;
    setKioskSaving(true);
    const {error}=await supabase.rpc("save_kiosk_contract",{
      p_venue_id:Number(kioskVenueId),p_kiosk_code:bill.kiosk.kiosk_code,p_kiosk_name:bill.kiosk.kiosk_name,
      p_rent_amount:kioskNumber(draft.rent),p_service_fee:kioskNumber(draft.serviceFee),p_garbage_fee:kioskNumber(draft.garbageFee),p_security_fee:kioskNumber(draft.securityFee),
      p_lease_start:draft.leaseStart||null,p_lease_end:draft.leaseEnd||null,p_deposit_amount:kioskNumber(draft.deposit),
      p_rent_period_start:draft.rentPeriodStart||null,p_rent_period_end:draft.rentPeriodEnd||null,p_escalation_rate:Number(draft.escalationRate)||0,
      p_escalation_start:draft.escalationStart||null,p_escalation_end:draft.escalationEnd||null,
    });
    setKioskSaving(false);
    if(error){setMessage(error.message);return;}
    setMessage(`Đã lưu hồ sơ hợp đồng của ${bill.kiosk.kiosk_name}.`);
    await loadKioskBills(kioskMonth,kioskVenueId);
  }

  function exportKioskBillImage(bill:KioskBill){
    const draft=kioskDrafts[bill.id];if(!draft||!bill.kiosk)return;
    const electric=Math.max(0,(kioskNumber(draft.electricNew)-kioskNumber(draft.electricOld))*5500);
    const water=Math.max(0,(kioskNumber(draft.waterNew)-kioskNumber(draft.waterOld))*12000);
    const closing=parseVietnameseDate(draft.closingDate)||bill.closing_date;
    const appliedRate=Number(draft.escalationRate)>0&&(!draft.escalationStart||closing>=draft.escalationStart)&&(!draft.escalationEnd||closing<=draft.escalationEnd)?Number(draft.escalationRate):0;
    const rent=kioskNumber(draft.rent)*(1+appliedRate/100);
    const rows:[[string,number],[string,number],[string,number],[string,number],[string,number],[string,number],[string,number],[string,number]]=[
      ["Tiền thuê",rent],["Tiền điện",electric],["Tiền nước",water],["Phí dịch vụ",kioskNumber(draft.serviceFee)],
      ["Tiền rác",kioskNumber(draft.garbageFee)],["Phí an ninh",kioskNumber(draft.securityFee)],["Phụ thu",kioskNumber(draft.surcharge)],["Nợ tháng trước",kioskNumber(draft.previousDebt)]
    ];
    const total=rows.reduce((sum,[,amount])=>sum+amount,0);
    const canvas=document.createElement("canvas"),width=1080,padding=70,rowHeight=58,height=430+rows.length*rowHeight;
    canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");if(!ctx)return;
    ctx.fillStyle="#f6fbf7";ctx.fillRect(0,0,width,height);ctx.fillStyle="#075236";ctx.fillRect(0,0,width,175);
    ctx.fillStyle="#fff";ctx.font="700 42px Arial";ctx.fillText("HÓA ĐƠN THU KIOS",padding,68);ctx.font="600 27px Arial";ctx.fillText(`Kỳ thu ${kioskMonth.slice(5,7)}/${kioskMonth.slice(0,4)} · ${kioskVenueName}`,padding,116);
    ctx.fillStyle="#123d2c";ctx.font="700 34px Arial";ctx.fillText(bill.kiosk.kiosk_name,padding,235);ctx.font="500 25px Arial";ctx.fillText(`Hạn thanh toán: ${draft.dueDate||displayVietnameseDate(bill.due_date)}`,padding,278);
    let y=340;ctx.font="600 26px Arial";rows.forEach(([label,amount])=>{ctx.fillStyle="#426655";ctx.fillText(label,padding,y);ctx.fillStyle="#123d2c";ctx.textAlign="right";ctx.fillText(`${amount.toLocaleString("vi-VN")} đ`,width-padding,y);ctx.textAlign="left";ctx.strokeStyle="#d2e4d8";ctx.beginPath();ctx.moveTo(padding,y+18);ctx.lineTo(width-padding,y+18);ctx.stroke();y+=rowHeight;});
    ctx.fillStyle="#0d7650";ctx.fillRect(padding,y+22,width-padding*2,96);ctx.fillStyle="#fff";ctx.font="700 32px Arial";ctx.fillText("TỔNG PHẢI THANH TOÁN",padding+28,y+62);ctx.textAlign="right";ctx.font="700 38px Arial";ctx.fillText(`${total.toLocaleString("vi-VN")} đ`,width-padding-28,y+66);ctx.textAlign="left";
    const link=document.createElement("a");link.download=`Hoa-don-${bill.kiosk.kiosk_code}-${kioskMonth}.png`;link.href=canvas.toDataURL("image/png");link.click();
    setMessage(`Đã xuất ảnh hóa đơn của ${bill.kiosk.kiosk_name}. Bạn có thể gửi ảnh này qua Zalo.`);
  }

  async function markKioskPaid(bill:KioskBill) {
    if (!kioskPaidDate) { setMessage("Phải chọn ngày đóng trước khi xác nhận."); return; }
    const paidAmount=kioskNumber(kioskPaymentAmounts[bill.id]||"");
    if (paidAmount<=0) { setMessage("Phải nhập số tiền thực tế Kios đã đóng."); return; }
    const billId=await saveKioskBill(bill,{reload:false,silent:true});
    if (!billId) return;
    setKioskSaving(true);
    const accountingDate=activeShift?.performance_date||kioskPaidDate;
    const {data,error}=await supabase.rpc("mark_kiosk_bill_paid",{p_bill_id:billId,p_paid_date:accountingDate,p_paid_amount:paidAmount});
    setKioskSaving(false);
    if (error) { setMessage(error.message); return; }
    const financeEntryId=data?.[0]?.finance_entry_id;
    if (session?.access_token && appsScriptSyncUrl) {
      void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncKioskBill",accessToken:session.access_token,publishableKey:supabaseKey,billId})});
      if (financeEntryId) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncFinanceRevenue",accessToken:session.access_token,publishableKey:supabaseKey,financeEntryId})});
    }
    const debt=Number(data?.[0]?.carried_debt||0);
    setMessage(debt>0?`Đã ghi nhận lần thanh toán này. Kios còn phải thu ${debt.toLocaleString("vi-VN")} đ trong tháng.`:"Đã thu đủ và cập nhật Doanh Thu Kios.");
    setFinanceDate(accountingDate);
    await Promise.all([loadKioskBills(),loadKioskApprovalHistory(),loadFinance(accountingDate,"day")]);
  }

  function openMenuItem(item:string) {
    const staffTabs:Record<string,typeof personnelTab>={"Danh Sách Nhân Sự":"directory","Chấm Công":"attendance","Lịch Của Tôi":"mySchedule","Lịch Nhân Sự":"schedule","Lịch Trang Phục":"costume","Đăng Ký Off":"off","Thi Đua":"competition","Lương Và Thu Nhập":"payroll","Trạng Thái Đề Xuất":"requests"};
    if (staffTabs[item]) {
      const target=staffTabs[item];
      if(target==="attendance"&&attendanceEmployees.length===0){setMessage("Nhân sự Loto không thuộc phạm vi chấm công này.");return;}
      if(profile?.role==="employee"&&!employeePersonnelTabs.includes(target as typeof employeePersonnelTabs[number])){
        setPersonnelTab("mySchedule");setMessage("");return;
      }
      setPersonnelTab(target); setModuleSection("Nhân Sự Tư Hậu"); setActiveMenu(null); setPanel("staffManagement"); if(target==="requests")void loadRegistrationTracking(); return;
    }
    if (item === "File Vé") { setHistoryMode(false); return void openTicketWorkspace(); }
    if (item === "Lịch Sử File Vé") return void openTicketHistory();
    if (item === "Check In / Check Out Khu") { const date=activeShift?.performance_date||localDateValue();const scopedVenue=profile?.role==="manager"?profile.venue_id:null;setLotoAreaVenueId(scopedVenue?String(scopedVenue):"");setActiveMenu(null);setModuleSection("Loto");setLotoAttendanceDate(date);setPanel("lotoAttendance");void loadLotoAreaAttendance(date,scopedVenue?String(scopedVenue):"");return; }
    if (item === "Nhập Kho Vé" || item === "Xuất Kho Vé") {
      if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé.");return;}
      return void openTicketInventoryEntry();
    }
    if (item === "Báo Cáo Vé") return void openTicketReport();
    if (item === "Nhập Kho Vé Trò Chơi") {
      if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé trò chơi.");return;}
      const allowedVenues=venues.filter(venue=>profile?.role!=="manager"||venue.id===profile.venue_id);
      const defaultVenue=profile?.role==="manager"?profile.venue_id:(Number(venueId)||allowedVenues[0]?.id||null);
      setGameInventoryVenueId(defaultVenue?String(defaultVenue):"");
      setGameInventoryDrafts({ticket_10k_quantity:"0",ticket_20k_quantity:"0",inflatable_20k_quantity:"0",nlh_30k_quantity:"0"});
      setMessage("");setActiveMenu(null);setModuleSection("Trò Chơi");setPanel("gameInventory");
      if(defaultVenue)void loadGameInventory(String(defaultVenue));
      return;
    }
    if (item === "Báo Cáo Trò Chơi") return void openGameReport();
    if (item === "Thu Tiền Kios") return void openKioskRevenue();
    // Doanh thu Trò Chơi phải nhập theo từng loại vé. Màn báo cáo tự tính
    // thành tiền từ số lượng và đồng bộ bản ghi doanh thu, không cho nhập một
    // con số tổng không thể đối chiếu với tồn kho.
    if (item === "Doanh Thu Trò Chơi") return void openGameReport();
    if (item.startsWith("Doanh Thu")) return void openFinance("revenue",menuFinanceCategory(item));
    if (item.startsWith("Chi")) return void openFinance("expense",menuFinanceCategory(item));
    setMessage(`Danh mục ${item} sẽ được triển khai ở bước tiếp theo.`);
  }

  async function loadLotoAreaAttendance(selectedDate?:string,selectedVenueId=lotoAreaVenueId){
    const date=selectedDate||lotoAttendanceDate||activeShift?.performance_date||localDateValue();
    const venueScope=profile?.role==="manager"?profile.venue_id:(Number(selectedVenueId)||null);
    const {data,error}=await supabase.functions.invoke("loto-area-attendance",{body:{action:"list",venue_id:venueScope,start:`${date.slice(0,7)}-01`,end:date}});
    if(error||data?.error){setMessage(data?.error||error?.message||"Không tải được báo cáo Check In / Check Out.");return;}setLotoAttendanceRows(data.rows||[]);
  }
  function selectLotoPhotos(kind:"check_in"|"check_out", list:FileList|null){
    const selected=Array.from(list||[]);
    const accepted=selected.slice(0,20);
    if(selected.length>20)setMessage("Mỗi lần chỉ được chọn tối đa 20 ảnh; hệ thống giữ 20 ảnh đầu tiên.");
    if(kind==="check_in")setLotoCheckInPhotos(accepted);else setLotoCheckOutPhotos(accepted);
  }
  async function submitLotoAreaPhoto(kind:"check_in"|"check_out"){
    const files=kind==="check_in"?lotoCheckInPhotos:lotoCheckOutPhotos;const targetVenueId=profile?.role==="manager"?profile.venue_id:Number(lotoAreaVenueId);if(!files.length)return;
    if(!targetVenueId){setMessage("Vui lòng chọn sân khấu trước khi gửi ảnh.");return;}
    if(kind==="check_in"){
      const nowParts=new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Bangkok",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date());
      const hour=Number(nowParts.find(part=>part.type==="hour")?.value||0);
      const minute=Number(nowParts.find(part=>part.type==="minute")?.value||0);
      if(hour*60+minute>18*60&&!lotoLateReason.trim()){
        setMessage("Check In sau 18:00 bắt buộc phải nhập lý do trước khi gửi ảnh.");
        return;
      }
    }
    if(files.length>20){setMessage("Mỗi lần chỉ được chọn tối đa 20 ảnh.");return;}
    if(files.some(file=>file.size>10*1024*1024)){setMessage("Mỗi ảnh phải nhỏ hơn hoặc bằng 10 MB.");return;}
    setLotoAttendanceLoading(true);setMessage(`Đang gửi 0/${files.length} ảnh…`);
    for(let index=0;index<files.length;index++){
      const form=new FormData();form.append("action",kind);form.append("venue_id",String(targetVenueId));form.append("work_date",lotoAttendanceDate);form.append("late_reason",lotoLateReason);form.append("photo",files[index]);
      const {data,error}=await supabase.functions.invoke("loto-area-attendance",{body:form});
      if(error||data?.error){setLotoAttendanceLoading(false);setMessage(`Đã gửi ${index}/${files.length} ảnh. ${data?.error||error?.message||"Không gửi được ảnh tiếp theo."}`);await loadLotoAreaAttendance();return;}
      setMessage(`Đang gửi ${index+1}/${files.length} ảnh…`);
    }
    setLotoAttendanceLoading(false);setMessage(`Đã gửi đủ ${files.length} ảnh ${kind==="check_in"?"Check In":"Check Out"}.`);if(kind==="check_in")setLotoCheckInPhotos([]);else setLotoCheckOutPhotos([]);await loadLotoAreaAttendance();
  }
  async function reviewLotoLate(id:number,decision:"approved"|"rejected"){
    const {data,error}=await supabase.functions.invoke("loto-area-attendance",{body:{action:"review",id,decision}});if(error||data?.error){setMessage(data?.error||error?.message||"Không thể duyệt.");return;}setMessage(data.message);await loadLotoAreaAttendance();
  }

  function openTicketInventoryEntry() {
    if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé.");return;}
    const defaultVenueId=activeShift?.venue_id||operationalVenueId||profile?.venue_id||venues[0]?.id||"";
    setInventoryVenueId(String(defaultVenueId));
    setMessage("");
    setActiveMenu(null);setModuleSection("Loto");setPanel("ticketInventoryEntry");
  }

  async function loadInventoryStock(targetVenueId=inventoryVenueId) {
    if (!targetVenueId) { setInventoryStockRows([]); return; }
    setInventoryStockLoading(true);
    const {data,error}=await supabase.from("ticket_inventory").select("id,code,handover_quantity,status,updated_at").eq("business_id",profile?.business_id||0).eq("venue_id",Number(targetVenueId)).eq("status","active").order("code");
    setInventoryStockLoading(false);
    if (error) { setMessage("Không thể tải tồn kho vé của sân khấu đã chọn."); return; }
    setInventoryStockRows((data||[]) as InventoryStockRow[]);
  }

  async function updateTicketInventoryActual() {
    if (!profile||!session||!inventoryVenueId||inventoryEditingId===null||inventoryUpdating) return;
    if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được sửa số lượng tồn kho vé.");return;}
    const quantity=Number(inventoryEditQuantity);
    if (!Number.isInteger(quantity)||quantity<0) { setMessage("Tồn thực tế phải là số nguyên từ 0 trở lên."); return; }
    const selected=inventoryStockRows.find(row=>row.id===inventoryEditingId);
    if (!selected) { setMessage("Không tìm thấy mã vé trong kho sân khấu đang chọn."); return; }
    setInventoryUpdating(true);
    const isCancelled=quantity<5;
    const {data,error}=await supabase.from("ticket_inventory").update({
      handover_quantity:quantity,
      status:isCancelled?"cancelled":"active",
      cancelled_by:isCancelled?session.user.id:null,
      cancelled_at:isCancelled?new Date().toISOString():null,
      updated_at:new Date().toISOString()
    }).eq("id",inventoryEditingId).eq("business_id",profile.business_id).eq("venue_id",Number(inventoryVenueId)).select("id,code,handover_quantity,status,updated_at").maybeSingle();
    setInventoryUpdating(false);
    if (error) { setMessage(`Không thể cập nhật tồn mã ${selected.code}: ${error.message}`); return; }
    if (!data) { setMessage("Không có quyền cập nhật mã vé này hoặc mã không thuộc sân khấu đang chọn."); return; }
    if (appsScriptSyncUrl) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncTicketInventory",accessToken:session.access_token,publishableKey:supabaseKey,venueId:Number(inventoryVenueId),inventoryIds:[inventoryEditingId]})});
    setInventoryEditingId(null);
    setInventoryEditQuantity("");
    setMessage(`Đã cập nhật mã ${selected.code} còn ${quantity.toLocaleString("vi-VN")} vé trong kho ${venues.find(venue=>venue.id===Number(inventoryVenueId))?.name||"sân khấu"}.`);
    await loadInventoryStock(inventoryVenueId);
    if (activeShift?.venue_id===Number(inventoryVenueId)) await loadTicketWorkspace(activeShift.id,activeShift.venue_id);
  }
  async function loadGameInventory(targetVenueId=gameInventoryVenueId) {
    if(!targetVenueId){
      setGameInventoryRows([]);
      setGameInventoryCounts({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
      return;
    }
    setGameInventoryLoading(true);
    const {data,error}=await supabase.from("game_ticket_inventory").select("id,product_key,quantity_on_hand,updated_at").eq("business_id",profile?.business_id||0).eq("venue_id",Number(targetVenueId));
    setGameInventoryLoading(false);
    if(error){
      setMessage(error.message);
      setGameInventoryRows([]);
      setGameInventoryCounts({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
      return;
    }
    const rows=(data||[]) as GameInventoryRow[];
    setGameInventoryRows(rows);
    const quantityByProduct=new Map(rows.map(row=>[row.product_key,String(Number(row.quantity_on_hand||0))]));
    setGameInventoryCounts({
      ticket_10k_quantity:quantityByProduct.get("ticket_10k")||"0",
      ticket_20k_quantity:quantityByProduct.get("ticket_20k")||"0",
      inflatable_20k_quantity:quantityByProduct.get("inflatable_20k")||"0",
      nlh_30k_quantity:quantityByProduct.get("nlh_30k")||"0"
    });
  }

  async function saveGameInventory(){
    if(gameInventorySaveLockRef.current||gameInventorySaving)return;
    if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé trò chơi.");return;}
    if(!gameInventoryVenueId){setMessage("Vui lòng chọn sân khấu cần nhập kho.");return;}
    const keyMap:Record<GameQuantityKey,GameInventoryRow["product_key"]>={ticket_10k_quantity:"ticket_10k",ticket_20k_quantity:"ticket_20k",inflatable_20k_quantity:"inflatable_20k",nlh_30k_quantity:"nlh_30k"};
    const items=Object.entries(gameInventoryDrafts).map(([key,value])=>({product_key:keyMap[key as GameQuantityKey],quantity:Number(value||0)})).filter(item=>Number.isInteger(item.quantity)&&item.quantity>0);
    if(!items.length){setMessage("Nhập số lượng bổ sung cho ít nhất một loại vé.");return;}
    gameInventorySaveLockRef.current=true;
    setGameInventorySaving(true);
    try{
      const {data,error}=await supabase.rpc("stock_in_game_tickets",{p_venue_id:Number(gameInventoryVenueId),p_items:items,p_note:"Nhập kho từ website"});
      if(error){setMessage(error.message);return;}
      if(Array.isArray(data))setGameInventoryRows(data as GameInventoryRow[]);
      setGameInventoryDrafts({ticket_10k_quantity:"0",ticket_20k_quantity:"0",inflatable_20k_quantity:"0",nlh_30k_quantity:"0"});
      setMessage(`Đã cộng ${items.reduce((sum,item)=>sum+item.quantity,0).toLocaleString("vi-VN")} vé vào đúng kho ${venues.find(venue=>String(venue.id)===gameInventoryVenueId)?.name||"sân khấu"}.`);
      await loadGameInventory(gameInventoryVenueId);
    }finally{
      gameInventorySaveLockRef.current=false;
      setGameInventorySaving(false);
    }
  }

  async function reconcileGameInventory(){
    if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được sửa số lượng tồn kho vé trò chơi.");return;}
    if(!gameInventoryVenueId){setMessage("Vui lòng chọn sân khấu cần kiểm kê.");return;}
    const keyMap:Record<GameQuantityKey,GameInventoryRow["product_key"]>={ticket_10k_quantity:"ticket_10k",ticket_20k_quantity:"ticket_20k",inflatable_20k_quantity:"inflatable_20k",nlh_30k_quantity:"nlh_30k"};
    const items=Object.entries(gameInventoryCounts).filter(([,value])=>value!=="").map(([key,value])=>({product_key:keyMap[key as GameQuantityKey],actual_quantity:Number(value)})).filter(item=>Number.isInteger(item.actual_quantity)&&item.actual_quantity>=0);
    if(!items.length){setMessage("Nhập ít nhất một số tồn thực tế cần đối chiếu.");return;}
    setGameInventoryLoading(true);
    const {error}=await supabase.rpc("reconcile_game_ticket_inventory",{p_venue_id:Number(gameInventoryVenueId),p_items:items,p_note:"Kiểm kê tồn thực tế từ website"});
    setGameInventoryLoading(false);
    if(error){setMessage(error.message);return;}
    setGameInventoryCounts({ticket_10k_quantity:"",ticket_20k_quantity:"",inflatable_20k_quantity:"",nlh_30k_quantity:""});
    setMessage(`Đã đối chiếu và cập nhật tồn thực tế đúng kho ${venues.find(venue=>String(venue.id)===gameInventoryVenueId)?.name||"sân khấu"}.`);
    await loadGameInventory(gameInventoryVenueId);
  }

  function printInventoryStock() {
    if (!inventoryVenueId||!inventoryStockRows.length) {
      setMessage("Vui lòng chọn sân khấu có dữ liệu tồn kho trước khi in.");
      return;
    }
    window.print();
  }

  async function saveTicketInventoryEntry() {
    if(!canManageTicketInventory){setMessage("Chỉ Admin và Chủ Sở Hữu được cập nhật kho vé.");return;}
    if (!session||!inventoryVenueId) { setMessage("Vui lòng chọn sân khấu trước khi nhập kho vé."); return; }
    const items=inventoryEntryRows.filter(row=>row.code.trim()||row.handover).map(row=>({code:row.code.trim(),handover_quantity:Number(row.handover)}));
    if (!items.length) { setMessage("Phải nhập ít nhất một mã vé và số lượng bàn giao."); return; }
    if (items.some(item=>!/^\d+$/.test(item.code)||!Number.isInteger(item.handover_quantity)||item.handover_quantity<=0)) { setMessage("Mã vé chỉ gồm chữ số và Bàn Giao phải lớn hơn 0."); return; }
    const duplicateInBatch=[...new Set(items.map(item=>item.code).filter((code,index,codes)=>codes.indexOf(code)!==index))];
    if (duplicateInBatch.length) { setMessage(`Mã vé bị trùng trong danh sách đang nhập: ${duplicateInBatch.join(", ")}.`); return; }
    setInventoryEntrySaving(true);
    const {data:existingInventory,error:existingError}=await supabase.from("ticket_inventory").select("code").eq("business_id",profile.business_id).eq("venue_id",Number(inventoryVenueId)).eq("status","active").in("code",items.map(item=>item.code));
    if (existingError) { setInventoryEntrySaving(false); setMessage("Không thể kiểm tra mã vé hiện có. Chưa có dữ liệu nào được lưu."); return; }
    const existingCodes=[...new Set((existingInventory||[]).map(item=>String(item.code)))];
    if (existingCodes.length) { setInventoryEntrySaving(false); setMessage(`Không thể nhập trùng mã vé đã có trong kho sân khấu này: ${existingCodes.join(", ")}.`); return; }
    const {data,error}=await supabase.rpc("add_ticket_inventory_batch",{p_venue_id:Number(inventoryVenueId),p_items:items});
    setInventoryEntrySaving(false);
    if (error) { setMessage(error.message); return; }
    const inventoryIds=(data||[]).map((item:{ticket_inventory_id:number})=>item.ticket_inventory_id);
    if (appsScriptSyncUrl&&inventoryIds.length) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncTicketInventory",accessToken:session.access_token,publishableKey:supabaseKey,venueId:Number(inventoryVenueId),inventoryIds})});
    setInventoryEntryRows([{id:crypto.randomUUID(),code:"",handover:""}]);
    const stageName=venues.find(venue=>venue.id===Number(inventoryVenueId))?.name||"Sân Khấu";
    setMessage(`Đã nhập ${items.length} mã vé vào kho ${stageName}.`);
    await loadInventoryStock(inventoryVenueId);
    if (activeShift?.venue_id===Number(inventoryVenueId)) await loadTicketWorkspace(activeShift.id,activeShift.venue_id);
  }

  async function loadFinance(date=financeDate,period=financePeriod,venueOverride?:number) {
    const financeVenueId=venueOverride||operationalVenueId;
    if (!financeVenueId) return;
    date = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : activeShift?.performance_date && /^\d{4}-\d{2}-\d{2}$/.test(activeShift.performance_date) ? activeShift.performance_date : localDateValue();
    setFinanceDate(date);
    setFinanceLoading(true);
    const range=financeDateRange(date,period);
    let financeQuery = supabase.from("finance_entries")
      .select("id,entry_date,entry_type,category,amount,note,status,created_at,venue_id")
      .eq("venue_id",financeVenueId).gte("entry_date",range.start).lte("entry_date",range.end)
      .order("entry_date").order("created_at");
    if(profile?.role!=="owner"&&profile?.role!=="manager")financeQuery=financeQuery.or("entry_type.eq.revenue,status.eq.approved");
    const {data,error}=await financeQuery;
    if (error) setMessage(error.message);
    setFinanceEntries((data || []) as FinanceEntry[]);
    const bonusStart=new Date(date+"T00:00:00"); bonusStart.setDate(bonusStart.getDate()-100);
    const bonusEnd=new Date(date+"T00:00:00"); bonusEnd.setDate(bonusEnd.getDate()+40);
    const {data:weeklyData,error:weeklyError}=await supabase.from("loto_weekly_revenue")
      .select("week_start,week_end,weekly_revenue,target_amount,achieved,proposed_bonus,settlement_id,settlement_date,paid_at")
      .eq("venue_id",financeVenueId).gte("week_start",inputDate(bonusStart)).lte("week_end",inputDate(bonusEnd)).order("week_start",{ascending:false});
    if (weeklyError) setMessage(weeklyError.message); else setBonusWeeks((weeklyData||[]) as BonusWeek[]);
    setFinanceLoading(false);
  }

  async function settleLotoBonuses() {
    if (!operationalVenueId) return;
    const today=localDateValue();
    const {data,error}=await supabase.rpc("settle_loto_weekly_bonuses",{p_venue_id:operationalVenueId,p_settlement_date:today});
    if (error) { setMessage(error.message); return; }
    const result=data?.[0];
    setMessage(`Đã chốt ${Number(result?.settled_weeks||0)} tuần, tổng thưởng ${Number(result?.total_bonus||0).toLocaleString("vi-VN")} đ.`);
    await loadFinance();
  }

  async function openFinance(mode:"revenue"|"expense"="revenue", category="loto") {
    const allowedVenues=venues.filter(venue=>profile?.role!=="manager"||venue.id===profile.venue_id);
    const selectedVenueId=operationalVenueId||profile?.venue_id||allowedVenues[0]?.id||0;
    // Thu/Chi theo sân khấu và ngày được chọn, không yêu cầu phải mở File Vé.
    // Khi không có ngày đã chọn, mặc định dùng ngày hiện tại.
    const targetDate=financeDate||localDateValue();
    setActiveMenu(null); setModuleSection(sectionForCategory(category)); setFinanceMode(mode); setFinanceCategory(category); setPanel("finance");
    setFinanceDate(targetDate);setFinanceEntryDate(targetDate);
    if (!selectedVenueId) { setMessage("Chưa có sân khấu để nhập và xem Thu Chi."); return; }
    setFinanceVenueOverride(selectedVenueId);setVenueId(String(selectedVenueId));setMessage("");
    await loadFinance(targetDate,financePeriod,selectedVenueId);
  }

  async function openTicketHistory() {
    setActiveMenu(null);setModuleSection("Loto");setHistoryMode(true);
    const defaultVenue=profile?.role==="manager"?profile.venue_id:Number(venueId)||venues[0]?.id;
    const date=activeShift?.performance_date||localDateValue();
    setHistoryVenueId(String(defaultVenue||""));setHistoryDate(date);setPanel("ticketHistory");
  }

  async function loadHistoricalTicket() {
    const targetVenue=Number(historyVenueId); if(!targetVenue||!historyDate||!profile) return;
    const {data:historyShifts,error}=await supabase.from("shifts").select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").eq("business_id",profile.business_id).eq("venue_id",targetVenue).eq("performance_date",historyDate).order("opened_at",{ascending:false});
    if(error||!historyShifts?.length){setMessage("");return;}
    const primary=historyShifts[0] as Shift;
    setHistoryMode(true);setMessage("");rememberTicketShift(primary);setVenueId(String(targetVenue));setShiftWorkDate(historyDate);await loadTicketWorkspace(primary.id,targetVenue);
    // Một ngày có thể có nhiều phiên đã đóng; lịch sử phải ghép toàn bộ vòng của tất cả phiên cùng sân khấu/ngày.
    if(historyShifts.length>1){
      const ids=historyShifts.map((shift:any)=>shift.id);
      const {data:extraRounds}=await supabase.from("ticket_rounds").select("client_id,sequence_no,ticket_price,gift_value,ticket_round_codes(slot,ticket_inventory:ticket_inventory_id(code)),ticket_sales(employee_id,quantity)").in("shift_id",ids).order("sequence_no");
      if(extraRounds?.length){setTicketRows(extraRounds.map((round:any)=>({id:round.client_id,codes:[1,2,3,4].map(slot=>round.ticket_round_codes?.find((item:any)=>item.slot===slot)?.ticket_inventory?.code||""),quantities:Object.fromEntries((round.ticket_sales||[]).map((sale:any)=>[sale.employee_id,String(sale.quantity)])),price:Number(round.ticket_price),gift:Number(round.gift_value)?String(round.gift_value):"",...promotionMetaFromClientId(round.client_id)})))}
    }
    setPanel("tickets");
  }

  function openRevenueVenue(id:number|null){
    if(!profile||(profile.role!=="owner"&&profile.role!=="manager"))return;
    if(profile.role==="manager")id=profile.venue_id;
    if(!id&&profile.role==="manager"){setMessage("Tài khoản quản lý chưa được gán sân khấu.");return;}
    const overviewDate=overviewRevenueDate||overviewRevenue?.date||activeShift?.performance_date||localDateValue();
    if(id===null){setOverviewRevenueSelection("company"); setFinanceVenueOverride(null); setVenueId(""); setFinanceCategory("all"); setFinanceMode("revenue"); void loadFinance(overviewDate,financePeriod); void loadOverviewRevenue(activeShift,null,overviewDate); return;}
    setOverviewRevenueSelection(String(id));
    setFinanceVenueOverride(id);
    setVenueId(String(id));
    setFinanceCategory("loto"); setFinanceMode("revenue"); void loadFinance(overviewDate,"day",id);
    void loadOverviewRevenue(activeShift,id,overviewDate);
  }

  async function saveBonusResponsibleEmployee(targetVenueId:number,employeeId:string) {
    if(!profile||!session||!targetVenueId)return;
    const previous=bonusResponsibleByVenue[targetVenueId]||"";
    setBonusResponsibleByVenue(current=>({...current,[targetVenueId]:employeeId}));
    const {error}=await supabase.from("venue_loto_bonus_settings").upsert({
      venue_id:targetVenueId,
      business_id:profile.business_id,
      responsible_employee_id:employeeId?Number(employeeId):null,
      updated_by:session.user.id,
      updated_at:new Date().toISOString(),
    },{onConflict:"venue_id"});
    if(error){
      setBonusResponsibleByVenue(current=>({...current,[targetVenueId]:previous}));
      setMessage(`Không thể lưu nhân sự phụ trách: ${error.message}`);
      return;
    }
    const employeeName=employees.find(employee=>employee.id===Number(employeeId))?.full_name;
    const venueName=venues.find(venue=>venue.id===targetVenueId)?.name||"sân khấu";
    setMessage(employeeName?`Đã lưu ${employeeName} phụ trách thưởng Loto của ${venueName}.`:`Đã bỏ nhân sự phụ trách thưởng Loto của ${venueName}.`);
  }

  async function loadGoAnLacNightRewards(venueId:number,date:string){
    if(!profile||!venueId||!date)return;
    const {data,error}=await supabase.from("go_an_lac_night_rewards").select("employee_id,performance_date,revenue_amount,reward_amount").eq("business_id",profile.business_id).eq("venue_id",venueId).eq("performance_date",date).order("employee_id");
    if(error){setMessage(error.message);return;}
    setGoAnLacResponsibleIds([...(data||[]).map(row=>String(row.employee_id)),"",""].slice(0,3));
  }

  async function saveGoAnLacNightRewards(){
    if(!profile||!session||!bonusResponsibleVenueId||!overviewRevenue)return;
    const employeeIds=goAnLacResponsibleIds.map(Number).filter(id=>id>0);
    if(employeeIds.length!==3||new Set(employeeIds).size!==3){setMessage("Sân Khấu Go An Lạc phải chọn đúng 3 nhân sự phụ trách cho đêm diễn này.");return;}
    const revenue=Number(overviewRevenue.current.categories.loto||0);
    if(revenue<=10000000){setMessage("Doanh thu Loto phải trên 10.000.000 đ mới ghi nhận thưởng.");return;}
    setGoAnLacRewardSaving(true);
    const date=overviewRevenue.date;
    const {error:deleteError}=await supabase.from("go_an_lac_night_rewards").delete().eq("business_id",profile.business_id).eq("venue_id",bonusResponsibleVenueId).eq("performance_date",date);
    if(deleteError){setGoAnLacRewardSaving(false);setMessage(deleteError.message);return;}
    const rewardAmount=Math.round(revenue*0.04);
    const {error}=await supabase.from("go_an_lac_night_rewards").insert(employeeIds.map(employee_id=>({business_id:profile.business_id,venue_id:bonusResponsibleVenueId,performance_date:date,employee_id,revenue_amount:revenue,reward_rate:0.04,reward_amount:rewardAmount,created_by:session.user.id})));
    setGoAnLacRewardSaving(false);
    if(error){setMessage(error.message);return;}
    setGoAnLacNightRewards(current=>[...current.filter(row=>row.performance_date!==date||!employeeIds.includes(row.employee_id)),...employeeIds.map(employee_id=>({employee_id,performance_date:date,revenue_amount:revenue,reward_amount:rewardAmount}))]);
    setMessage(`Đã ghi nhận thưởng ${rewardAmount.toLocaleString("vi-VN")} đ cho mỗi nhân sự Gò An Lạc; tổng 12% doanh thu Loto.`);
  }

  function changeOverviewRevenueDate(date:string){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;
    setOverviewRevenueDate(date);
    const selectedVenue=overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):null;
    void loadOverviewRevenue(activeShift,selectedVenue,date);
    if(selectedVenue)void loadFinance(date,"day",selectedVenue);
  }

  async function saveFinanceEntry() {
    if (!operationalVenueId || !profile || !session || !financeAmount) return;
    if (financeMode === "revenue" && financeCategory === "loto") { setMessage("Doanh Thu Loto được cập nhật tự động từ File Vé."); return; }
    const amount=Number(financeAmount.replace(/\D/g,""));
    if (!amount) { setMessage("Số tiền phải lớn hơn 0."); return; }
    setSaving(true);
    const { data: savedEntry,error }=await supabase.from("finance_entries").insert({
      client_id:crypto.randomUUID(),business_id:profile.business_id,venue_id:operationalVenueId,shift_id:activeShift?.id||null,
      entry_date:financeEntryDate||financeDate||activeShift?.performance_date||localDateValue(),entry_type:financeMode,category:financeCategory,amount,note:financeNote.trim()||null,
      status:financeMode === "revenue" ? "approved" : "pending",created_by:session.user.id,
    }).select("id").single();
    setSaving(false);
    if (error) { setMessage(error.message); return; }
    if (financeMode === "revenue" && savedEntry?.id && appsScriptSyncUrl) {
      void fetch(appsScriptSyncUrl,{
        method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},
        body:JSON.stringify({action:"syncFinanceRevenue",accessToken:session.access_token,publishableKey:supabaseKey,financeEntryId:savedEntry.id}),
      });
    }
    setFinanceAmount(""); setFinanceNote("");
    setMessage(financeMode === "revenue" ? "Đã cập nhật khoản thu." : "Đã gửi khoản chi về mục Duyệt.");
    await Promise.all([loadFinance(financeDate,financePeriod,operationalVenueId),loadApprovals()]);
  }

  async function loadFixedExpenses(){
    if(!profile||profile.role==="employee")return;
    setFixedExpenseLoading(true);
    let obligationQuery=supabase.from("fixed_expense_obligations").select("id,venue_id,employee_id,expense_month,due_date,category,title,amount_due,created_at,employee:employees(full_name)").eq("business_id",profile.business_id).order("due_date");
    if(profile.role==="manager"&&profile.venue_id)obligationQuery=obligationQuery.eq("venue_id",profile.venue_id);
    const [{data:rows,error},{data:payments,error:paymentError}]=await Promise.all([
      obligationQuery,
      supabase.from("finance_entries").select("amount,note,status,entry_date").eq("business_id",profile.business_id).eq("entry_type","expense").like("note","%[FIXED_EXPENSE:%")
    ]);
    setFixedExpenseLoading(false);
    if(error||paymentError){setMessage(error?.message||paymentError?.message||"Không tải được công nợ.");return;}
    const totals:Record<string,{approved:number;pending:number}>={};
    for(const payment of payments||[]){
      const match=String(payment.note||"").match(/\[FIXED_EXPENSE:(\d+)(?::(\d{4}-\d{2}))?\]/);
      const id=Number(match?.[1]||0);if(!id)continue;
      const month=match?.[2]||String(payment.entry_date||"").slice(0,7);
      const key=`${id}:${month}`;
      if(!totals[key])totals[key]={approved:0,pending:0};
      if(payment.status==="approved")totals[key].approved+=Number(payment.amount||0);else if(payment.status==="pending")totals[key].pending+=Number(payment.amount||0);
    }
    setFixedExpenses((rows||[]) as unknown as FixedExpenseObligation[]);setFixedExpensePayments(totals);
  }

  async function saveFixedExpense(){
    if(!profile||!session||profile.role==="employee")return;
    const venueId=profile.role==="manager"?Number(profile.venue_id||0):Number(fixedExpenseForm.venueId||0);
    const payrollEmployee=employees.find(item=>item.id===Number(fixedExpenseForm.employeeId));
    const isPayroll=fixedExpenseForm.category==="payroll";
    const payrollSummary=monthlySalaryPaymentSummary(payrollEmployee);
    const amount=isPayroll?payrollSummary.total:Number(fixedExpenseForm.amount.replace(/\D/g,""));
    const title=isPayroll&&payrollEmployee?`Chi lương tháng ${payrollEmployee.full_name}`:fixedExpenseForm.title.trim();
    if(!venueId||!fixedExpenseForm.dueDate||(isPayroll&&!payrollEmployee)||!title||amount<=0){setMessage(isPayroll?"Vui lòng chọn nhân sự có lương tháng và kiểm tra số tiền thực nhận.":"Vui lòng nhập đủ ngày chi, sân khấu, nội dung và số tiền.");return;}
    setFixedExpenseLoading(true);
    const values={venue_id:venueId,employee_id:Number(fixedExpenseForm.employeeId)||null,expense_month:fixedExpenseForm.dueDate.slice(0,7)+"-01",due_date:fixedExpenseForm.dueDate,category:fixedExpenseForm.category,title,amount_due:amount};
    const {error}=editingFixedExpenseId
      ? await supabase.from("fixed_expense_obligations").update(values).eq("id",editingFixedExpenseId).eq("business_id",profile.business_id)
      : await supabase.from("fixed_expense_obligations").insert({...values,business_id:profile.business_id,created_by:session.user.id});
    setFixedExpenseLoading(false);
    if(error){setMessage(error.message);return;}
    setFixedExpenseForm(current=>({...current,employeeId:"",title:"",amount:""}));setEditingFixedExpenseId(null);setMessage(editingFixedExpenseId?"Đã cập nhật lịch chi cố định.":"Đã lưu lịch chi cố định và bật nhắc công nợ.");await loadFixedExpenses();
  }

  function monthlySalaryPaymentSummary(employee?:Employee|null){
    const base=Number(employee?.monthly_salary||0);
    const responsibility=Number(employee?.responsibility_amount||0);
    const bonus=Number(employee?.bonus_amount||0);
    const advances=employee?salaryAdvances.filter(item=>item.employee_id===employee.id&&["approved","sent_to_expense","paid"].includes(item.status)).reduce((sum,item)=>sum+Number(item.amount||0),0):0;
    return{base,responsibility,bonus,advances,total:Math.max(0,base+responsibility+bonus-advances)};
  }
  function editFixedExpense(item:FixedExpenseObligation){
    setEditingFixedExpenseId(item.id);
    setFixedExpenseMonth(item.due_date.slice(0,7));
    setFixedExpenseForm({dueDate:item.due_date,venueId:String(item.venue_id),employeeId:item.employee_id?String(item.employee_id):"",category:item.category,title:item.title,amount:String(item.amount_due)});
    setMessage("");
  }
  function cancelFixedExpenseEdit(){
    setEditingFixedExpenseId(null);
    setFixedExpenseForm(current=>({...current,employeeId:"",title:"",amount:""}));
  }
  async function submitFixedExpensePayment(item:FixedExpenseObligation){
    if(!profile||!session)return;
    const amount=Number((fixedExpensePaymentAmounts[item.id]||"").replace(/\D/g,""));
    const totals=fixedExpensePayments[`${item.id}:${fixedExpenseMonth}`]||{approved:0,pending:0};
    const remaining=Math.max(0,Number(item.amount_due)-totals.approved-totals.pending);
    if(amount<=0||amount>remaining){setMessage(`Số tiền gửi duyệt tối đa ${remaining.toLocaleString("vi-VN")} đ.`);return;}
    setFixedExpenseLoading(true);
    const category=item.category==="stage"?"loto":item.category==="payroll"?"payroll":item.category;
    const {error}=await supabase.from("finance_entries").insert({client_id:crypto.randomUUID(),business_id:profile.business_id,venue_id:item.venue_id,shift_id:null,entry_date:localDateValue(),entry_type:"expense",category,amount,note:`[FIXED_EXPENSE:${item.id}:${fixedExpenseMonth}] ${item.title}`,status:"pending",created_by:session.user.id});
    setFixedExpenseLoading(false);
    if(error){setMessage(error.message);return;}
    setFixedExpensePaymentAmounts(current=>({...current,[item.id]:""}));setMessage("Đã gửi khoản chi cố định về Tổng Quan để duyệt.");await Promise.all([loadFixedExpenses(),loadApprovals()]);
  }
  async function submitExpenseCenterRequest(){
    if(!profile||!session||!resolvedExpenseCenterVenueId)return;
    if(profile.role==="manager"&&resolvedExpenseCenterVenueId!==profile.venue_id){setMessage("Quản lý chỉ được gửi khoản chi của sân khấu mình phụ trách.");return;}
    if(profile.role==="employee"&&expenseCenterCategory!=="payroll"){setMessage("Nhân viên chỉ được gửi đề xuất ứng lương của chính mình.");return;}
    const amount=Number(expenseCenterAmount.replace(/\D/g,""));
    if(amount<=0){setMessage("Số tiền phải lớn hơn 0.");return;}
    if(expenseCenterPayrollType==="other"&&!expenseCenterNote.trim()){setMessage("Chi khác bắt buộc phải nhập diễn giải để đối chiếu.");return;}
    if(expenseCenterIsPayroll){
      if(!selectedExpenseEmployee){setMessage("Vui lòng chọn đúng nhân viên thuộc sân khấu này.");return;}
      if(profile.role==="employee"&&selectedExpenseEmployee.id!==profile.employee_id){setMessage("Bạn chỉ được gửi đề xuất ứng lương của chính mình.");return;}
      if(expenseCenterPayrollType==="advance"){
        const currentRequests=salaryAdvances.filter(item=>item.employee_id===selectedExpenseEmployee.id&&item.request_type==="salary"&&item.status!=="rejected");
        if(currentRequests.length>=2){setMessage("Nhân viên này đã đủ 2 lần ứng lương trong tháng.");return;}
        const installment=([1,2].find(value=>!currentRequests.some(item=>item.installment===value))||2);
        const salaryBase=selectedExpenseEmployee.pay_type==="monthly"?Number(selectedExpenseEmployee.monthly_salary||0):selectedExpenseEmployee.pay_type==="weekly"?Number(selectedExpenseEmployee.weekly_salary||0):selectedExpenseEmployee.pay_type==="daily"?Number(selectedExpenseEmployee.daily_rate||0):Number(selectedExpenseEmployee.hourly_rate||0);
        const alreadyRequested=currentRequests.reduce((sum,item)=>sum+Number(item.amount||0),0);
        if(salaryBase>0&&alreadyRequested+amount>salaryBase){setMessage(`Tổng tiền ứng không được vượt mức lương ${salaryBase.toLocaleString("vi-VN")} đ.`);return;}
        setExpenseCenterSaving(true);
        const {error}=await supabase.from("salary_advance_requests").insert({business_id:profile.business_id,employee_id:selectedExpenseEmployee.id,venue_id:resolvedExpenseCenterVenueId,request_month:expenseCenterDate.slice(0,7)+"-01",request_type:"salary",installment,amount,note:expenseCenterNote.trim()||null,requested_by:session.user.id});
        setExpenseCenterSaving(false);
        if(error){setMessage(error.code==="23505"?"Đợt ứng lương này đã được gửi trong tháng.":error.message);return;}
        setExpenseCenterAmount("");setExpenseCenterNote("");setMessage("Đã gửi đề xuất ứng lương để chủ sở hữu duyệt.");await loadSalaryAdvances();return;
      }
      if(profile.role==="employee"){setMessage("Chi lương chỉ dành cho quản lý hoặc chủ sở hữu đề xuất.");return;}
      const salaryBase=selectedExpenseEmployee.pay_type==="monthly"?Number(selectedExpenseEmployee.monthly_salary||0):selectedExpenseEmployee.pay_type==="weekly"?Number(selectedExpenseEmployee.weekly_salary||0):selectedExpenseEmployee.pay_type==="daily"?Number(selectedExpenseEmployee.daily_rate||0):Number(selectedExpenseEmployee.hourly_rate||0);
      const approvedAdvance=salaryAdvances.filter(item=>item.employee_id===selectedExpenseEmployee.id&&item.request_type==="salary"&&["approved","sent_to_expense","paid"].includes(item.status)).reduce((sum,item)=>sum+Number(item.amount||0),0);
      const availableSalary=Math.max(0,salaryBase-approvedAdvance-Number(approvedPayrollPayments[selectedExpenseEmployee.id]||0));
      if(salaryBase>0&&amount>availableSalary){setMessage(`Số tiền chi vượt phần lương còn lại ${availableSalary.toLocaleString("vi-VN")} đ.`);return;}
    }
    const category=expenseCenterIsPayroll?"payroll":expenseCenterCategory==="stage"?"loto":expenseCenterCategory;
    const payrollLabels={daily:"Trả lương ngày",weekly:"Trả lương tuần",monthly:"Trả lương tháng"} as const;
    const payrollPrefix=expenseCenterIsPayroll?`${payrollLabels[expenseCenterPayrollType as keyof typeof payrollLabels]||"Chi lương"} · ${selectedExpenseEmployee?.full_name||"Nhân viên"} · [EMPLOYEE:${selectedExpenseEmployee?.id||0}]`:"";
    const note=[payrollPrefix,expenseCenterNote.trim()].filter(Boolean).join(" · ")||null;
    setExpenseCenterSaving(true);
    const {error}=await supabase.from("finance_entries").insert({client_id:crypto.randomUUID(),business_id:profile.business_id,venue_id:resolvedExpenseCenterVenueId,shift_id:null,entry_date:expenseCenterDate,entry_type:"expense",category,amount,note,status:"pending",created_by:session.user.id});
    setExpenseCenterSaving(false);
    if(error){setMessage(error.message);return;}
    setExpenseCenterAmount("");setExpenseCenterNote("");setMessage("Đã gửi khoản chi về Tổng Quan để chờ duyệt.");await loadApprovals();
  }

  function renderFixedExpenseCenter(){
    if(!profile||profile.role==="employee")return null;
    const today=localDateValue();
    const selectedVenueId=profile.role==="manager"?Number(profile.venue_id||0):Number(fixedExpenseForm.venueId||resolvedExpenseCenterVenueId||0);
    const [selectedYear,selectedMonthNumber]=fixedExpenseMonth.split("-").map(Number);
    const lastDayOfSelectedMonth=new Date(selectedYear,selectedMonthNumber,0).getDate();
    const projectDueDate=(date:string)=>`${fixedExpenseMonth}-${String(Math.min(Number(date.slice(8,10))||1,lastDayOfSelectedMonth)).padStart(2,"0")}`;
    const projectedItems=fixedExpenses
      .filter(item=>(!selectedVenueId||item.venue_id===selectedVenueId)&&String(item.due_date).slice(0,7)<=fixedExpenseMonth)
      .map(item=>({...item,expense_month:`${fixedExpenseMonth}-01`,due_date:projectDueDate(item.due_date)}))
      .sort((a,b)=>a.due_date.localeCompare(b.due_date)||a.title.localeCompare(b.title,"vi"));
    const rows=projectedItems.map(item=>{const totals=fixedExpensePayments[`${item.id}:${fixedExpenseMonth}`]||{approved:0,pending:0};return{item,totals,remaining:Math.max(0,Number(item.amount_due)-totals.approved)};});
    const openItems=rows.filter(row=>row.remaining>0);
    const daysUntil=(date:string)=>Math.ceil((new Date(date+"T00:00:00").getTime()-new Date(today+"T00:00:00").getTime())/86400000);
    const urgentItems=fixedExpenseMonth===today.slice(0,7)?openItems.filter(row=>daysUntil(row.item.due_date)<=5):[];
    const selectedPayrollEmployee=employees.find(item=>item.id===Number(fixedExpenseForm.employeeId));
    const selectedPayrollSummary=monthlySalaryPaymentSummary(selectedPayrollEmployee);
    const venueName=(id:number)=>venues.find(venue=>venue.id===id)?.name||"Sân khấu";
    const monthStart=new Date(selectedYear,selectedMonthNumber-1,1);
    const dateOptions=Array.from({length:lastDayOfSelectedMonth},(_,index)=>`${selectedYear}-${String(selectedMonthNumber).padStart(2,"0")}-${String(index+1).padStart(2,"0")}`);
    const monthOptions=Array.from({length:25},(_,index)=>{const date=new Date(new Date().getFullYear(),new Date().getMonth()+index-12,1);const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;return{value,label:`Tháng ${String(date.getMonth()+1).padStart(2,"0")}/${date.getFullYear()}`};});
    const categoryLabel=(value:string)=>value==="stage"?"Sân Khấu":value==="loto"?"Loto":value==="game"?"Trò Chơi":value==="water"?"Quán Nước":value==="kiosk"?"Kios":value==="payroll"?"Lương Nhân Viên":"Khác";
    return <section className="fixed-expense-center">
      <header><div><p className="eyebrow">CHI CỐ ĐỊNH THEO THÁNG</p><h3>Danh Sách Chi Trong Tháng</h3><span>Lịch chi tự chuyển sang tháng mới và giữ nguyên ngày đã thiết lập.</span></div><div className="fixed-expense-month-summary"><label>Tháng Theo Dõi<select value={fixedExpenseMonth} onChange={event=>{const month=event.target.value;setFixedExpenseMonth(month);setEditingFixedExpenseId(null);setFixedExpenseForm(current=>({...current,dueDate:`${month}-${String(Math.min(Number(current.dueDate.slice(8,10))||1,new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate())).padStart(2,"0")}`}));}}>{monthOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label><b>{openItems.reduce((sum,row)=>sum+row.remaining,0).toLocaleString("vi-VN")} đ còn phải chi</b></div></header>
      {urgentItems.length>0&&<div className="fixed-expense-alerts">{urgentItems.map(({item,remaining})=><article className={daysUntil(item.due_date)<0?"overdue":""} key={`due-${item.id}`}><span>{daysUntil(item.due_date)<0?"CÔNG NỢ QUÁ HẠN":"CHI SẮP ĐẾN HẠN"}</span><strong>{item.title}</strong><small>{venueName(item.venue_id)} · {new Date(item.due_date+"T00:00:00").toLocaleDateString("vi-VN")}</small><b>{remaining.toLocaleString("vi-VN")} đ</b></article>)}</div>}
      <section className="monthly-salary-tracker fixed-monthly-expense-tracker">
        <div className="monthly-salary-tracker-heading"><div><span>{monthOptions.find(option=>option.value===fixedExpenseMonth)?.label.toUpperCase()}</span><strong>Toàn bộ lịch chi cố định</strong></div><small>{rows.length} khoản · Có thể sửa trực tiếp đúng khoản cần điều chỉnh</small></div>
        {rows.length===0?<p className="empty-note">Chưa có lịch chi cố định trong tháng này.</p>:<div className="monthly-salary-table-wrap"><table><thead><tr><th>Khoản Chi</th><th>Ngày Chi</th><th>Sân Khấu</th><th>Phải Chi</th><th>Đã Chi</th><th>Chờ Duyệt</th><th>Còn Lại</th><th>Thao Tác</th></tr></thead><tbody>{rows.map(({item,totals,remaining})=><tr key={item.id}><td><strong>{item.title}</strong><small>{categoryLabel(item.category)}{item.employee?.full_name?` · ${item.employee.full_name}`:""}</small></td><td><b>{new Date(item.due_date+"T00:00:00").toLocaleDateString("vi-VN")}</b><small>Lặp ngày {Number(item.due_date.slice(8,10))} mỗi tháng</small></td><td>{venueName(item.venue_id)}</td><td>{Number(item.amount_due).toLocaleString("vi-VN")} đ</td><td className="salary-plus">{totals.approved.toLocaleString("vi-VN")} đ</td><td>{totals.pending.toLocaleString("vi-VN")} đ</td><td className="salary-remaining">{remaining.toLocaleString("vi-VN")} đ</td><td><button className="fixed-expense-edit-button" onClick={()=>editFixedExpense(item)}>Sửa</button></td></tr>)}</tbody></table></div>}
      </section>
      <div className={`fixed-expense-form-card${editingFixedExpenseId?" is-editing":""}`}>
        <div className="fixed-expense-form-heading"><div><span>{editingFixedExpenseId?"ĐANG CHỈNH SỬA":"LẬP LỊCH CHI"}</span><strong>{editingFixedExpenseId?"Sửa khoản chi cố định":fixedExpenseForm.category==="payroll"?"Chi lương tháng":"Chi cố định khác"}</strong></div><small>Chỉ cần chọn ngày trong tháng; hệ thống tự lặp lịch ở các tháng tiếp theo.</small></div>
        <div className="fixed-expense-form">
          <label>Ngày Chi<select value={fixedExpenseForm.dueDate} onChange={event=>setFixedExpenseForm(current=>({...current,dueDate:event.target.value}))}>{dateOptions.map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label>
          <label>Sân Khấu<select disabled={profile.role==="manager"} value={selectedVenueId||""} onChange={event=>setFixedExpenseForm(current=>({...current,venueId:event.target.value,employeeId:""}))}><option value="">Chọn sân khấu</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label>
          <label>Bộ Phận<select value={fixedExpenseForm.category} onChange={event=>setFixedExpenseForm(current=>({...current,category:event.target.value,employeeId:event.target.value==="payroll"?current.employeeId:""}))}><option value="stage">Sân Khấu</option><option value="loto">Loto</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option><option value="kiosk">Kios</option><option value="payroll">Lương Nhân Viên</option><option value="other">Khác</option></select></label>
          {fixedExpenseForm.category==="payroll"&&<label>Nhân Sự<select value={fixedExpenseForm.employeeId} onChange={event=>{const employee=employees.find(item=>item.id===Number(event.target.value));const summary=monthlySalaryPaymentSummary(employee);setFixedExpenseForm(current=>({...current,employeeId:event.target.value,title:employee?`Chi lương tháng ${employee.full_name}`:"",amount:String(summary.total)}));}}><option value="">Chọn nhân sự lương tháng</option>{employees.filter(employee=>employee.pay_type==="monthly"&&(!selectedVenueId||!employee.account_venue_id||employee.account_venue_id===selectedVenueId)).map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>}
          {fixedExpenseForm.category!=="payroll"&&<><label className="fixed-expense-title">Nội Dung Chi<input value={fixedExpenseForm.title} placeholder="Ví dụ: Tiền thuê mặt bằng" onChange={event=>setFixedExpenseForm(current=>({...current,title:event.target.value}))}/></label><label>Số Tiền<MoneyInput value={fixedExpenseForm.amount} placeholder="Nhập số tiền" onValueChange={amount=>setFixedExpenseForm(current=>({...current,amount}))}/></label></>}
          {fixedExpenseForm.category==="payroll"&&selectedPayrollEmployee&&<div className="fixed-payroll-summary"><div><span>Lương tháng</span><b>{selectedPayrollSummary.base.toLocaleString("vi-VN")} đ</b></div><div><span>Trách nhiệm</span><b>+ {selectedPayrollSummary.responsibility.toLocaleString("vi-VN")} đ</b></div><div><span>Thưởng</span><b>+ {selectedPayrollSummary.bonus.toLocaleString("vi-VN")} đ</b></div><div className="advance"><span>Đã ứng</span><b>− {selectedPayrollSummary.advances.toLocaleString("vi-VN")} đ</b></div><div className="net"><span>Thực nhận</span><b>{selectedPayrollSummary.total.toLocaleString("vi-VN")} đ</b></div></div>}
          <div className="fixed-expense-form-actions"><button className="fixed-expense-save" disabled={fixedExpenseLoading} onClick={()=>void saveFixedExpense()}>{fixedExpenseLoading?"Đang Lưu…":editingFixedExpenseId?"Lưu Thay Đổi":fixedExpenseForm.category==="payroll"?"Lưu Lịch Chi Lương":"Lưu Lịch Chi"}</button>{editingFixedExpenseId&&<button className="fixed-expense-cancel" onClick={cancelFixedExpenseEdit}>Hủy Sửa</button>}</div>
        </div>
      </div>
      <div className="fixed-expense-list">{openItems.length===0?<p className="empty-note">Tháng này không còn khoản chi cần xử lý.</p>:openItems.map(({item,totals,remaining})=><article key={item.id}><div><span>{categoryLabel(item.category)}</span><strong>{item.title}</strong><small>{venueName(item.venue_id)} · Hạn {new Date(item.due_date+"T00:00:00").toLocaleDateString("vi-VN")}{item.employee?.full_name?` · ${item.employee.full_name}`:""}</small></div><dl><div><dt>Phải chi</dt><dd>{Number(item.amount_due).toLocaleString("vi-VN")} đ</dd></div><div><dt>Đã duyệt chi</dt><dd>{totals.approved.toLocaleString("vi-VN")} đ</dd></div><div><dt>Đang chờ duyệt</dt><dd>{totals.pending.toLocaleString("vi-VN")} đ</dd></div><div><dt>Còn lại</dt><dd>{remaining.toLocaleString("vi-VN")} đ</dd></div></dl><div className="fixed-expense-pay"><MoneyInput value={fixedExpensePaymentAmounts[item.id]||""} placeholder="Số tiền chi lần này" onValueChange={value=>setFixedExpensePaymentAmounts(current=>({...current,[item.id]:value}))}/><button disabled={fixedExpenseLoading||!fixedExpensePaymentAmounts[item.id]||remaining-totals.pending<=0} onClick={()=>void submitFixedExpensePayment(item)}>Gửi Duyệt Chi</button></div></article>)}</div>
    </section>;
  }  function startEditingFinance(item:FinanceEntry){
    setEditingFinanceId(item.id);setFinanceMode(item.entry_type);setFinanceCategory(item.category);
    setFinanceEntryDate(item.entry_date);setFinanceAmount(String(item.amount));setFinanceNote(item.note||"");setMessage("");
  }

  function cancelEditingFinance(){setEditingFinanceId(null);setFinanceAmount("");setFinanceNote("");}

  async function updateFinanceEntry(){
    if(!editingFinanceId||!operationalVenueId||!financeAmount)return;
    const current=financeEntries.find(item=>item.id===editingFinanceId);
    if(!current)return;
    if(current.entry_type==="revenue"&&["loto","game","kiosk"].includes(current.category)){
      setMessage("Khoản thu tự động phải chỉnh tại File Vé, Báo Cáo Trò Chơi hoặc Thu Kios để giữ đúng đối chiếu.");return;
    }
    const amount=Number(financeAmount.replace(/\D/g,""));
    if(!amount){setMessage("Số tiền phải lớn hơn 0.");return;}
    setSaving(true);
    const {error}=await supabase.from("finance_entries").update({entry_date:financeEntryDate,amount,note:financeNote.trim()||null,updated_at:new Date().toISOString()}).eq("id",editingFinanceId).eq("venue_id",operationalVenueId);
    setSaving(false);
    if(error){setMessage(error.message);return;}
    setEditingFinanceId(null);setFinanceAmount("");setFinanceNote("");setMessage("Đã cập nhật khoản thu chi của khu vực.");
    await Promise.all([loadFinance(financeDate,financePeriod,operationalVenueId),loadApprovals()]);
  }

  async function loadApprovals() {
    if(approvalsLoadInFlightRef.current)return;
    approvalsLoadInFlightRef.current=true;
    setApprovalHistoryLoading(true);
    try{
    const [{data:expenses},{data:tickets},{data:offRequests},{data:advanceRequests},{data:expenseHistory},{data:offHistory},{data:advanceHistory},{data:kioskHistory}] = await Promise.all([
      supabase.from("finance_entries").select("id,entry_date,entry_type,category,amount,note,status,created_at,venue_id").eq("entry_type","expense").eq("status","pending").order("created_at"),
      Promise.resolve({data:[] as TicketApproval[]}),
      supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at,employee:employees(full_name)").eq("status","pending").order("created_at"),
      supabase.from("salary_advance_requests").select("id,employee_id,venue_id,request_month,request_type,installment,amount,note,status,created_at,employee:employees(full_name)").eq("status","pending").order("created_at"),
      supabase.from("finance_entries").select("id,entry_date,entry_type,category,amount,note,status,created_at,venue_id").eq("entry_type","expense").in("status",["approved","rejected"]).order("created_at",{ascending:false}),
      supabase.from("staff_time_off_requests").select("id,employee_id,off_date,week_start,status,note,created_at,employee:employees(full_name)").in("status",["approved","rejected"]).order("created_at",{ascending:false}),
      supabase.from("salary_advance_requests").select("id,employee_id,venue_id,request_month,request_type,installment,amount,note,status,created_at,employee:employees(full_name)").neq("status","pending").order("created_at",{ascending:false}),
      supabase.from("kiosk_payments").select("id,venue_id,bill_id,paid_date,amount,created_by,created_at,bill:bill_id(billing_month,kiosk:kiosk_id(kiosk_code,kiosk_name))").order("created_at",{ascending:false}),
    ]);
    setPendingExpenses((expenses || []) as FinanceEntry[]);
    setTicketApprovals((tickets || []) as unknown as TicketApproval[]);
    setTimeOffApprovals(((offRequests||[]) as unknown as TimeOffRequest[]).filter(item=>timeOffNeedsApproval(item.off_date,item.note)));
    setSalaryAdvanceApprovals((advanceRequests||[]) as unknown as SalaryAdvance[]);
    setApprovalExpenseHistory((expenseHistory||[]) as FinanceEntry[]);
    setApprovalTimeOffHistory((offHistory||[]) as unknown as TimeOffRequest[]);
    setApprovalAdvanceHistory((advanceHistory||[]) as unknown as SalaryAdvance[]);
    setApprovalKioskHistory((kioskHistory||[]) as unknown as KioskApprovalHistory[]);
    }finally{setApprovalHistoryLoading(false);approvalsLoadInFlightRef.current=false;}
  }

  async function reviewTimeOff(id:number,decision:"approved"|"rejected"){
    if(profile?.role!=="owner")return;
    const current=[...timeOffApprovals,...trackedTimeOffRequests].find(item=>item.id===id);
    let note=current?.note||null;
    if(decision==="rejected"){
      const reason=prompt("Nhập lý do không duyệt để người đề xuất nắm:",rejectionReasonFromNote(note));
      if(reason===null)return;
      if(!reason.trim()){setMessage("Bắt buộc nhập lý do khi không duyệt.");return;}
      note=noteWithRejectionReason(note,reason);
    }
    const {error}=await supabase.from("staff_time_off_requests").update({status:decision,note,reviewed_by:session?.user.id,reviewed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id);
    if(error){setMessage(error.message);return;}
    setMessage(decision==="approved"?"Đã duyệt đăng ký Off.":"Đã từ chối đăng ký Off.");
    await Promise.all([loadApprovals(),loadTimeOffRequests(),loadRegistrationTracking()]);
  }

  async function reviewExpense(id:number,decision:"approved"|"rejected") {
    const {error}=await supabase.rpc("review_finance_expense",{p_entry_id:id,p_decision:decision,p_note:null});
    if (error) { setMessage(error.message); return; }
    if (decision==="approved" && session?.access_token && appsScriptSyncUrl) void fetch(appsScriptSyncUrl,{method:"POST",mode:"no-cors",headers:{"Content-Type":"text/plain"},body:JSON.stringify({action:"syncFinanceExpense",accessToken:session.access_token,publishableKey:supabaseKey,financeEntryId:id})});
    setMessage(decision === "approved" ? "Đã duyệt khoản chi và cập nhật báo cáo ngày." : "Đã từ chối khoản chi.");
    await Promise.all([loadApprovals(),loadFinance()]);
  }

  async function approveTicketFromQueue(item:TicketApproval) {
    await approveCancellation(item.round_id,item.slot);
    await loadApprovals();
  }

  async function approveTicketVenueGroup(venueId:number,items:TicketApproval[]) {
    if(profile?.role!=="owner"||!items.length)return;
    const venueName=venues.find(venue=>venue.id===venueId)?.name||"sân khấu này";
    if(!confirm(`Duyệt hủy toàn bộ ${items.length} mã vé dưới 5 của ${venueName}?\n\nCác mã đã duyệt sẽ bị loại khỏi kho vé của đúng sân khấu này.`))return;
    setSaving(true);setMessage("");
    let approvedCount=0;
    for(const item of items){
      const {error}=await supabase.rpc("approve_ticket_cancellation",{p_round_id:item.round_id,p_slot:item.slot});
      if(error){setSaving(false);setMessage(`Đã duyệt ${approvedCount}/${items.length} mã. Dừng tại mã ${item.ticket_inventory?.code||"—"}: ${error.message}`);await loadApprovals();return;}
      approvedCount+=1;
    }
    setSaving(false);
    setMessage(`Đã duyệt hủy ${approvedCount} mã vé của ${venueName}. Các mã này đã được loại khỏi kho vé.`);
    await loadApprovals();
    if(String(venueId)===ticketInventoryVenueId)await loadTicketInventory(String(venueId));
  }

  function printTicketVenueGroup(venueId:number,items:TicketApproval[]) {
    const venueName=venues.find(venue=>venue.id===venueId)?.name||"Chưa Xác Định Sân Khấu";
    const escapeHtml=(value:unknown)=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]||char));
    const rows=items.map((item,index)=>{
      const workDate=item.round?.shift?.performance_date;
      const dateLabel=workDate?new Date(workDate+"T00:00:00").toLocaleDateString("vi-VN"):"—";
      return `<tr><td>${index+1}</td><td>${escapeHtml(item.ticket_inventory?.code||"—")}</td><td>${escapeHtml(item.actual_remaining??"—")}</td><td>${escapeHtml(dateLabel)}</td><td>${escapeHtml(item.round?.sequence_no||"—")}</td></tr>`;
    }).join("");
    // Giữ tham chiếu cửa sổ in để có thể ghi nội dung và gọi print().
    // `noopener` làm một số trình duyệt trả về null dù cửa sổ đã được mở.
    const popup=window.open("about:blank","ticket-cancellation-print","width=1000,height=760");
    if(!popup){setMessage("Trình duyệt đang chặn cửa sổ in. Vui lòng cho phép cửa sổ bật lên rồi thử lại.");return;}
    popup.document.write(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Đề xuất hủy vé - ${escapeHtml(venueName)}</title><style>body{font-family:Arial,sans-serif;margin:28px;color:#123f30}h1{margin:0 0 6px;font-size:24px}p{margin:0 0 20px;color:#526b61}table{width:100%;border-collapse:collapse}th,td{padding:10px;border:1px solid #aacbbb;text-align:center}th{color:#fff;background:#0d6848}@media print{body{margin:12mm}}</style></head><body><h1>Đề Xuất Hủy Vé Dưới 5</h1><p>${escapeHtml(venueName)} · ${items.length} mã vé</p><table><thead><tr><th>STT</th><th>Mã Vé</th><th>Số Tồn</th><th>Ngày Làm Việc</th><th>Vòng</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    popup.document.close();
    popup.focus();
    window.setTimeout(()=>{popup.print();},250);
  }

  async function closeCurrentShift() {
    if (!activeShift || !profile || !session) return;
    const ownerTakeover=ticketOwnedByAnother&&profile.role==="owner";
    const confirmation=ownerTakeover
      ? `Đóng ca bằng quyền Chủ sở hữu?\n\nTài khoản ${ticketLockOwnerName} sẽ mất quyền chỉnh sửa ngay. Sau đó bạn có thể mở lại đúng ca vừa đóng để tiếp quản.`
      : "Đóng ca làm việc ngay? Báo Cáo Vé có thể chọn ngày và hoàn tất sau.";
    if(!confirm(confirmation))return;
    setSaving(true); setMessage("");
    // Chủ sở hữu tiếp quản phải chốt bản nháp đang đồng bộ trước khi đóng ca.
    // Nếu bỏ qua bước này thì ca có thể đã đóng nhưng Báo Cáo Vé và doanh thu
    // vẫn chỉ đọc dữ liệu cũ từ lần lưu trước của nhân viên.
    const saved=await saveTicketRows();
    if(!saved){setSaving(false);return;}
    const {error}=await supabase.rpc("close_ticket_shift",{p_shift_id:activeShift.id});
    const {data}=error?{data:null}:await supabase.from("shifts")
      .select("id,name,venue_id,opened_at,opened_by,closed_by,closed_at,performance_date,kinh_trung_amount,status")
      .eq("id",activeShift.id).eq("business_id",profile.business_id).maybeSingle();
    setSaving(false);
    if (error) { setMessage(error.message); return; }
    if (!data) { setMessage("Không thể đóng ca hoặc ca này đã được đóng trước đó."); return; }
    rememberTicketShift(data as Shift);
    // Khi đóng một ca của ngày trước, Tổng Quan phải tự xem đúng ngày làm việc
    // của File Vé thay vì mặc định giữ ngày hiện tại.
    if(data.performance_date)setOverviewRevenueDate(data.performance_date);
    setMessage(ownerTakeover
      ? `Đã đóng ca bằng quyền Chủ sở hữu. Tài khoản ${ticketLockOwnerName} đã bị khóa khỏi File Vé này. Bạn có thể mở lại đúng ca vừa đóng để tiếp quản.`
      : "Đã đóng ca. Admin hoặc Quản lý có thể mở lại đúng ca này nếu cần chỉnh sửa.");
  }

  async function reopenCurrentShift() {
    if (!activeShift || !profile || !session || activeShift.status!=="closed" || !["owner","manager"].includes(profile.role)) return;
    if (!confirm(`Mở lại đúng ca ${activeShift.name} để chỉnh sửa?`)) return;
    setSaving(true); setMessage("");
    const {data:otherOpen,error:checkError}=await supabase.from("shifts")
      .select("id").eq("business_id",profile.business_id).eq("venue_id",activeShift.venue_id)
      .eq("status","open").neq("id",activeShift.id).limit(1).maybeSingle();
    if(checkError){setSaving(false);setMessage(checkError.message);return;}
    if(otherOpen){setSaving(false);setMessage("Sân khấu này đang có một ca khác hoạt động. Không thể mở lại ca cũ.");return;}
    const {data,error}=await supabase.from("shifts")
      .update({status:"open",opened_by:session.user.id,opened_at:new Date().toISOString(),closed_by:null,closed_at:null})
      .eq("id",activeShift.id).eq("business_id",profile.business_id)
      .eq("venue_id",activeShift.venue_id).eq("status","closed")
      .select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").maybeSingle();
    setSaving(false);
    if(error){setMessage(error.message);return;}
    if(!data){setMessage("Không thể mở lại ca này hoặc ca đã được mở trước đó.");return;}
    setHistoryMode(false);rememberTicketShift(data as Shift);
    await loadTicketWorkspace(data.id,data.venue_id);
    setMessage("Đã mở lại đúng ca vừa đóng. Bạn có thể chỉnh sửa File Vé.");
  }

  async function reopenSelectedShift(shift:Shift) {
    if (!profile || !session || shift.status!=="closed" || !["owner","manager"].includes(profile.role)) return false;
    const {data:otherOpen,error:checkError}=await supabase.from("shifts")
      .select("id").eq("business_id",profile.business_id).eq("venue_id",shift.venue_id)
      .eq("status","open").neq("id",shift.id).limit(1).maybeSingle();
    if(checkError){setMessage(checkError.message);return false;}
    if(otherOpen){setMessage("Sân khấu này đang có một ca hoạt động. Hãy đóng ca đó trước khi mở lại ca cũ.");return false;}
    const {data,error}=await supabase.from("shifts")
      .update({status:"open",opened_by:session.user.id,opened_at:new Date().toISOString(),closed_by:null,closed_at:null})
      .eq("id",shift.id).eq("business_id",profile.business_id).eq("venue_id",shift.venue_id).eq("status","closed")
      .select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").maybeSingle();
    if(error){setMessage(error.message);return false;}
    if(!data){setMessage("Không thể mở lại ca vừa đóng.");return false;}
    setHistoryMode(false);rememberTicketShift(data as Shift);
    await loadTicketWorkspace(data.id,data.venue_id);
    setPanel("tickets");
    setMessage("Đã mở lại đúng phiên làm việc vừa đóng. Không tạo phiên mới.");
    return true;
  }

  async function openTicketWorkspace() {
    setActiveMenu(null);setHistoryMode(false);
    setModuleSection("Loto");setMessage("");setSearch("");
    // File Vé luôn nạp lại danh sách ngắn gọn của riêng màn này. Nhờ đó tên
    // sân khấu và toàn bộ nhân sự Loto vẫn hiện đủ, kể cả khi phần hồ sơ đầy
    // đủ ở màn trước đang tải lại hoặc có trường dữ liệu chưa tương thích.
    const [{data:ticketVenues},{data:ticketStaff}]=await Promise.all([
      supabase.from("venues").select("id,name,is_active").eq("is_active",true).order("name"),
      // File Vé cũng cần mức CASE của hồ sơ để hiển thị đúng cho Đờn và Soát Vé.
      // Không chỉ nạp tên rồi ghi đè danh sách hồ sơ đầy đủ.
      supabase.from("employees").select("id,full_name,is_active,department,loto_role,weekday_case,weekend_case,holiday_case,tet_case,half_case").eq("is_active",true).eq("department","loto").order("full_name"),
    ]);
    const loadedVenues=(ticketVenues||[]).map((venue:any)=>({...venue,id:Number(venue.id)})) as Venue[];
    if(loadedVenues.length)setVenues(loadedVenues);
    if(ticketStaff?.length)setEmployees(ticketStaff as Employee[]);
    const venueOptions=loadedVenues.length?loadedVenues:venues;
    const defaultVenue=profile?.role==="manager"?profile.venue_id:Number(venueId)||venueOptions[0]?.id;
    if(defaultVenue)setVenueId(String(defaultVenue));
    const {data:openShifts}=await supabase.from("shifts").select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").eq("business_id",profile?.business_id||0).eq("status","open").order("opened_at",{ascending:false});
    setOpenVenueShifts((openShifts||[]).map((shift:any)=>({...shift,id:Number(shift.id),venue_id:Number(shift.venue_id)})) as Shift[]);
    setShiftWorkDate(activeShift?.performance_date||localDateValue());
    setShiftName(`File Vé ${new Intl.DateTimeFormat("vi-VN").format(new Date())}`);
    setSelectedStaff([]);setPanel("ticketSetup");
  }

  function markTicketEditing(){
    ticketLocalDirtyRef.current=true;
    ticketLocalEditUntilRef.current=Date.now()+5000;
  }

  function updateTicketRow(index: number, updater: (row: TicketRow) => TicketRow) {
    markTicketEditing();
    setTicketRows((current) => current.map((row, rowIndex) => rowIndex === index ? updater(row) : row));
  }

  function addTicketRows() {
    markTicketEditing();
    const count=Math.min(100,Math.max(1,Number(rowsToAdd)||1));
    setTicketRows(current => [...current,...Array.from({length:count},blankTicketRow)]);
  }

  function addBuyOneGiftOneRound() {
    if (!activeShift) { setMessage("Phải mở ca làm việc trước khi thêm vòng vé tặng."); return; }
    const venueName=(venues.find(item=>item.id===activeShift.venue_id)?.name||"").toLocaleLowerCase("vi-VN");
    if (!venueName.includes("đức hòa") && !venueName.includes("liên minh")) {
      setMessage("Vòng Mua 1 Tặng 1 chỉ áp dụng cho Sân Khấu Đức Hòa và Sân Khấu Liên Minh.");
      return;
    }
    if (ticketRows.some(row=>Boolean(row.promotionGroupId))) {
      setMessage("Phiên làm việc này đã có một vòng Mua 1 Tặng 1.");
      return;
    }
    const groupId=crypto.randomUUID();
    const sale:TicketRow={...blankTicketRow(),id:`promo-sale:${groupId}`,promotionRole:"sale",promotionGroupId:groupId};
    const gift:TicketRow={...blankTicketRow(),id:`promo-gift:${groupId}`,price:0,promotionRole:"gift",promotionGroupId:groupId};
    markTicketEditing();
    setTicketRows(current=>[...current,sale,gift]);
    setMessage("");
  }

  function updateTicketQuantity(rowIndex:number, employeeId:number, value:string) {
    markTicketEditing();
    setTicketRows(current=>{
      const source=current[rowIndex];
      return current.map((row,index)=>{
        if(index===rowIndex) return {...row,quantities:{...row.quantities,[employeeId]:value}};
        if(source?.promotionRole==="sale" && row.promotionRole==="gift" && row.promotionGroupId===source.promotionGroupId) {
          return {...row,quantities:{...row.quantities,[employeeId]:value}};
        }
        return row;
      });
    });
  }

  function ticketCodeUsedElsewhere(code: string, rowIndex: number, slot: number) {
    return Boolean(code) && ticketRows.some((row, otherRow) => row.codes.some((currentCode, otherSlot) => ticketCodeKey(currentCode) === ticketCodeKey(code) && (otherRow !== rowIndex || otherSlot !== slot)));
  }

  function setTicketCode(rowIndex: number, slot: number, code: string) {
    if (ticketCodeUsedElsewhere(code, rowIndex, slot)) {
      setMessage(`Mã vé ${code} đã được sử dụng trong ca làm việc này.`);
      return;
    }
    setMessage("");
    updateTicketRow(rowIndex, current => ({ ...current, codes: current.codes.map((value, index) => index === slot ? code : value) }));
  }

  function inputTicketCode(rowIndex:number,slot:number,value:string){
    const code=value.replace(/\D/g,"");
    setMessage("");
    updateTicketRow(rowIndex,current=>({...current,codes:current.codes.map((currentCode,index)=>index===slot?code:currentCode)}));
  }

  function ticketCodeIssue(code:string){
    if(!code)return "";
    if(ticketRows.flatMap(row=>row.codes).filter(currentCode=>ticketCodeKey(currentCode)===ticketCodeKey(code)).length>1)return "duplicate";
    if(!resolveTicketItem(code,ticketInventoryCatalog))return "missing";
    if(!ticketReadOnly&&!resolveTicketItem(code,ticketInventory))return "reserved";
    return "";
  }

  function ticketCodeIssueLabel(code:string){
    return ticketCodeIssue(code)==="duplicate" ? "Mã vé bị trùng trong File Vé" : ticketCodeIssue(code)==="missing" ? "Mã này không tồn tại" : ticketCodeIssue(code)==="reserved" ? "Đang chờ đối chiếu từ ca trước" : "";
  }

  async function validateTicketCode(rowIndex:number,slot:number,code:string){
    if(!code){setMessage("");return;}
    let catalog=ticketInventoryCatalog;
    let available=ticketInventory;
    if(!resolveTicketItem(code,catalog)&&activeShift){
      const refreshed=await refreshUsableTicketInventory(activeShift.id,activeShift.venue_id);
      catalog=refreshed.catalog;available=refreshed.available;
    }
    const matched=resolveTicketItem(code,catalog);
    if(!matched){
      setMessage(`Mã ${code} không tồn tại trong kho vé của ${selectedVenueName}.`);
      return;
    }
    if(!resolveTicketItem(code,available)){
      setMessage(`Mã ${code} đang chờ đối chiếu từ ca trước.`);
      return;
    }
    if(ticketCodeUsedElsewhere(code,rowIndex,slot)){
      setMessage(`Mã vé ${code} đã được sử dụng trong ca làm việc này.`);
      return;
    }
    if(matched.code!==code)setTicketCode(rowIndex,slot,matched.code);
    else setMessage("");
  }

  function ticketTotals(row: TicketRow) {
    if (!ticketRowHasCode(row)) return { opening: 0, sold: 0, remaining: 0, amount: 0 };
    const selectedCodes = [...new Set(row.codes.filter(Boolean))];
    const opening = selectedCodes.reduce((sum, code) => sum + Number(resolveTicketItem(code,ticketInventoryCatalog)?.handover_quantity || 0), 0);
    const sold = shiftStaff.reduce((sum, person) => sum + Number(row.quantities[person.id] || 0), 0);
    const gift = Number(row.gift || 0);
    return { opening, sold, remaining: opening - sold, amount: sold * row.price - gift };
  }

  function employeeCaseValue(person: Pick<Employee,"weekday_case"|"weekend_case"|"holiday_case"|"tet_case"|"half_case"> & {support_100k?:number;support_200k?:number}) {
    const shiftDay=activeShift?.performance_date?new Date(activeShift.performance_date+"T00:00:00").getDay():null;
    const isWeekendShift=shiftDay===0||shiftDay===6;
    if (caseMode === "weekend") return Number(person.weekend_case || 0);
    if (caseMode === "regular" && isWeekendShift) return Number(person.weekend_case || 0);
    if (caseMode === "holiday") return Number(person.holiday_case || 0);
    if (caseMode === "tet") return Number(person.tet_case || 0);
    if (caseMode === "half") return Math.round(Number((isWeekendShift?person.weekend_case:person.weekday_case)||0)*0.5);
    if (caseMode === "support100") return Number(person.support_100k || 100000);
    if (caseMode === "support200") return Number(person.support_200k || 200000);
    return Number(person.weekday_case || 0);
  }
  function employeeCase(person: ShiftPerson) { return employeeCaseValue(person); }
  function updateTicketExtraRole(role:"organ"|"ticketChecker",employeeId:string) {
    markTicketEditing();
    const nextExtraRoles={...ticketExtraRoles,[role]:employeeId};
    setTicketExtraRoles(nextExtraRoles);
    // Organ/Soát Vé là lựa chọn của cả phiên làm việc. Lưu ngay khi chọn để
    // người dùng rời File Vé ngay sau đó vẫn không làm mất lựa chọn vừa nhập.
    if(activeShift&&profile&&!ticketReadOnly&&ticketDraftReadyShiftRef.current===activeShift.id){
      const payload:TicketShiftDraft={rows:ticketRows,allowances,kinhTrung,extraRoles:nextExtraRoles,caseMode,clientId:ticketDraftClientId()};
      ticketLocalDirtyRef.current=true;
      const savedAt=new Date().toISOString();
      try{localStorage.setItem(`ticket-shift-draft:${activeShift.id}`,JSON.stringify({payload,savedAt}));}catch{}    void putOfflineTicketDraft({shiftId:activeShift.id,businessId:profile.business_id,venueId:activeShift.venue_id,payload,updatedBy:session?.user.id||"",savedAt,pending:true}).catch(()=>undefined);
      const revision=++ticketDraftRevisionRef.current;
      ticketDraftLatestRef.current={shiftId:activeShift.id,businessId:profile.business_id,venueId:activeShift.venue_id,payload,updatedBy:session?.user.id||"",revision};
      setTicketDraftStatus("saving");
      void saveTicketDraft();
    }
  }
  function handleKeyboardNavigation(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;

    const focusControl = (control?: HTMLInputElement | HTMLSelectElement) => {
      if (!control) return;
      control.focus();
      if (control instanceof HTMLInputElement && control.type !== "checkbox") control.select();
    };
    const controlsInRow = (row: HTMLTableRowElement) => Array.from(
      row.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input:not([disabled]), select:not([disabled])")
    );
    const ticketRow = target.closest<HTMLTableRowElement>(".work-table tbody tr");

    if (ticketRow) {
      const body = ticketRow.parentElement;
      if (!body) return;
      const rows = Array.from(body.querySelectorAll<HTMLTableRowElement>(":scope > tr"));
      const rowIndex = rows.indexOf(ticketRow);
      const rowControls = controlsInRow(ticketRow);
      const columnIndex = rowControls.indexOf(target);
      if (rowIndex < 0 || columnIndex < 0) return;

      let nextRow = rowIndex;
      let nextColumn = columnIndex;
      if (event.key === "Enter" || event.key === "ArrowDown") nextRow += 1;
      else if (event.key === "ArrowUp") nextRow -= 1;
      else if (event.key === "ArrowRight" || (event.key === "Tab" && !event.shiftKey)) {
        nextColumn += 1;
        if (nextColumn >= rowControls.length) { nextRow += 1; nextColumn = 0; }
      } else {
        nextColumn -= 1;
        if (nextColumn < 0) {
          nextRow -= 1;
          nextColumn = nextRow >= 0 ? Math.max(controlsInRow(rows[nextRow]).length - 1, 0) : 0;
        }
      }

      event.preventDefault();
      if (nextRow < 0) return;
      if (nextRow >= rows.length) {
        setTicketRows((current) => [...current, blankTicketRow()]);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const updatedRows = Array.from(document.querySelectorAll<HTMLTableRowElement>(".work-table tbody tr"));
          focusControl(updatedRows[nextRow] ? controlsInRow(updatedRows[nextRow])[nextColumn] : undefined);
        }));
        return;
      }
      const nextControls = controlsInRow(rows[nextRow]);
      focusControl(nextControls[Math.min(nextColumn, nextControls.length - 1)]);
      return;
    }

    const pageControls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      ".main-content input:not([disabled]), .main-content select:not([disabled])"
    )).filter((control) => control.offsetParent !== null);
    const currentIndex = pageControls.indexOf(target);
    if (currentIndex < 0) return;
    const backwards = event.key === "ArrowUp" || event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey);
    event.preventDefault();
    focusControl(pageControls[currentIndex + (backwards ? -1 : 1)]);
  }

  const summary = ticketRows.reduce((total, row) => {
    if (!ticketRowHasCode(row)) return total;
    const rowTotal = ticketTotals(row);
    if(row.promotionRole!=="gift") {
      total.gross += rowTotal.sold * row.price;
      total.gifts += Number(row.gift || 0);
    }
    return total;
  }, { gross: 0, gifts: 0 });
  const hasTicketData = ticketRows.some(ticketRowHasCode);
  const salaryTotal = hasTicketData ? shiftStaff.reduce((sum, person) => sum + employeeCase(person), 0) : 0;
  const allowanceTotal = hasTicketData ? shiftStaff.reduce((sum, person) => sum + Number(allowances[person.id] || 0), 0) : 0;
  const organEmployee=ticketStaffOptions.find(employee=>String(employee.id)===ticketExtraRoles.organ);
  const ticketCheckerEmployee=ticketStaffOptions.find(employee=>String(employee.id)===ticketExtraRoles.ticketChecker);
  // CASE của Organ/Soát Vé phải lấy từ hồ sơ nhân sự chuẩn. Bản ghi nhân sự
  // trong phiên chỉ là dữ liệu dự phòng vì một số phiên cũ không có đủ trường CASE.
  const organCasePerson=organEmployee||shiftStaff.find(person=>String(person.id)===ticketExtraRoles.organ);
  const ticketCheckerCasePerson=ticketCheckerEmployee||shiftStaff.find(person=>String(person.id)===ticketExtraRoles.ticketChecker);
  const shiftStaffIds=new Set(shiftStaff.map(person=>person.id));
  const extraRoleEmployees=[organEmployee,ticketCheckerEmployee].filter((employee,index,list):employee is Employee=>Boolean(employee)&&!shiftStaffIds.has(employee!.id)&&list.findIndex(item=>item?.id===employee!.id)===index);
  const extraRoleCaseTotal=hasTicketData?extraRoleEmployees.reduce((sum,employee)=>sum+employeeCaseValue(employee),0):0;
  const totalCase = salaryTotal + allowanceTotal + extraRoleCaseTotal;
  const kinhTrungTotal = hasTicketData ? Number(kinhTrung || 0) : 0;
  const netRevenue = summary.gross - summary.gifts - totalCase - kinhTrungTotal;

  async function signIn() {
    setMessage("");
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
    if (error) setMessage("Chưa thể đăng nhập Google. Vui lòng thử lại.");
  }

  function openLoginForm() {
    setActiveMenu(null);
    setPanel("publicHome");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById("public-login")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }

  async function signInInternal() {
    const username=loginUsername.trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username) || loginPassword.length < 8) {
      setMessage("Tên đăng nhập hoặc mật khẩu không hợp lệ.");
      return;
    }
    setLoginLoading(true); setMessage("");
    const email=`${username.toLowerCase()}@giadinh-tuhau.internal`;
    const { error }=await supabase.auth.signInWithPassword({email,password:loginPassword});
    setLoginLoading(false);
    if (error) {
      const connectionError=/fetch|network|timeout|offline/i.test(error.message||"");
      setMessage(connectionError?"Không kết nối được máy chủ đăng nhập. Vui lòng kiểm tra mạng và thử lại.":"Tên đăng nhập hoặc mật khẩu không đúng.");
    }
    else { setLoginPassword(""); setLoginUsername(""); }
  }

  async function loadUserAccounts() {
    if (profile?.role!=="owner") return;
    const {data,error}=await supabase.from("profiles").select("user_id,username,full_name,role,status,access_level,venue_id,employee_id").order("created_at");
    if(error){setMessage("Không tải được danh sách người dùng.");return;}
    setUserAccounts((data||[]) as UserAccount[]);
  }

  async function openUserManagement() {
    setPanel("users"); setMessage("");
    await loadUserAccounts();
  }

  async function createInternalUser() {
    if(!session||profile?.role!=="owner") return;
    if(!newUsername.trim()||newUserPassword.length<8||!newUserName.trim()||!newUserVenue){setMessage("Nhập đủ tên đăng nhập, mật khẩu, tên hiển thị và sân khấu.");return;}
    setUserSaving(true);setMessage("");
    const {data,error}=await supabase.functions.invoke("manage-internal-users",{body:{username:newUsername.trim(),password:newUserPassword,full_name:newUserName.trim(),access_level:Number(newUserLevel),venue_id:Number(newUserVenue),employee_id:newUserEmployee?Number(newUserEmployee):null}});
    setUserSaving(false);
    if(error||data?.error){setMessage(data?.error||error?.message||"Không tạo được người dùng.");return;}
    setNewUsername("");setNewUserPassword("");setNewUserName("");setNewUserLevel("3");setNewUserVenue("");setNewUserEmployee("");
    setMessage(`Đã tạo người dùng ${data.username}.`);
    await loadUserAccounts();
  }

  async function disableInternalUser(account: UserAccount) {
    if (!session || profile?.role !== "owner" || account.role === "owner" || account.status !== "active") return;
    const confirmed = window.confirm(`Ngừng quyền truy cập của ${account.full_name}?

Lịch sử làm việc của người này vẫn được giữ lại.`);
    if (!confirmed) return;
    setUserSaving(true); setMessage("");
    const { data, error } = await supabase.functions.invoke("manage-internal-users", {
      body: { action: "disable", target_user_id: account.user_id },
    });
    setUserSaving(false);
    if (error || data?.error) {
      setMessage(data?.error || error?.message || "Không thể xóa quyền người dùng.");
      return;
    }
    setMessage(`Đã ngừng quyền truy cập của ${account.full_name}.`);
    await loadUserAccounts();
  }

  function toggleStaff(id: number) {
    setSelectedStaff((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      return [...current, id];
    });
  }

  async function openShift() {
    if (!profile || !venueId || !shiftWorkDate) return;
    const openedWorkDate=shiftWorkDate||localDateValue();
    setSaving(true); setMessage("");
    // Tìm đúng File Vé theo sân khấu và ngày trước khi xét bất kỳ ca đang mở nào.
    // Nhờ đó một ca ở sân khấu/ngày khác không thể kéo màn hình đang thao tác đi nơi khác.
    const {data:matchingDayShifts,error:matchingDayError}=await supabase.from("shifts")
      .select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status")
      .eq("business_id",profile.business_id).eq("venue_id",Number(venueId))
      .eq("performance_date",openedWorkDate).order("id",{ascending:false});
    if(matchingDayError){setSaving(false);setMessage(matchingDayError.message);return;}
    if(matchingDayShifts?.length){
      // Dữ liệu lịch sử có thể đã có nhiều phiên cùng ngày. Ưu tiên phiên đang mở;
      // nếu tất cả đã đóng thì chỉ mở/xem phiên mới nhất, không tạo thêm phiên.
      const matchingShift=(matchingDayShifts.find(shift=>shift.status==="open")||matchingDayShifts[0]) as Shift;
      if(matchingShift.status==="closed"){
        if(["owner","manager"].includes(profile.role)){
          const reopened=await reopenSelectedShift(matchingShift);
          setSaving(false);
          if(reopened){setShiftWorkDate(openedWorkDate);setFinanceDate(openedWorkDate);}
          return;
        }
        rememberTicketShift(matchingShift);await loadTicketWorkspace(matchingShift.id,matchingShift.venue_id);setPanel("tickets");setSaving(false);
        setMessage("Ngày này đã có một phiên làm việc và phiên đã đóng. Chỉ Chủ sở hữu hoặc Quản lý được mở lại đúng phiên này.");
        return;
      }
      rememberTicketShift(matchingShift);setShiftWorkDate(openedWorkDate);setFinanceDate(openedWorkDate);setGameReportDate(openedWorkDate);setKioskPaidDate(openedWorkDate);
      await loadTicketWorkspace(matchingShift.id,matchingShift.venue_id);setPanel("tickets");setSaving(false);setMessage("");return;
    }
    const {data:existingShift,error:existingError}=await supabase.from("shifts")
      .select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status")
      .eq("business_id",profile.business_id).eq("venue_id",Number(venueId)).eq("status","open")
      .order("opened_at",{ascending:false}).limit(1).maybeSingle();
    if(existingError){setSaving(false);setMessage(existingError.message);return;}
    if(existingShift){
      const existingWorkDate=existingShift.performance_date||openedWorkDate;
      rememberTicketShift(existingShift as Shift);setShiftWorkDate(existingWorkDate);setFinanceDate(existingWorkDate);setGameReportDate(existingWorkDate);setKioskPaidDate(existingWorkDate);
      await loadTicketWorkspace(existingShift.id,existingShift.venue_id);setPanel("tickets");setSaving(false);
      setMessage("");return;
    }
    // Một sân khấu chỉ có duy nhất một File Vé trong cùng ngày làm việc.
    // Nếu phiên của ngày đó đã đóng thì chỉ được mở lại chính phiên này, tuyệt đối không tạo thêm.
    const {data:sameDayShift,error:sameDayError}=await supabase.from("shifts")
      .select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status")
      .eq("business_id",profile.business_id).eq("venue_id",Number(venueId))
      .eq("performance_date",openedWorkDate).order("id",{ascending:false}).limit(1).maybeSingle();
    if(sameDayError){setSaving(false);setMessage(sameDayError.message);return;}
    if(sameDayShift){
      if(sameDayShift.status==="closed"){
        if(["owner","manager"].includes(profile.role)){
          const reopened=await reopenSelectedShift(sameDayShift as Shift);
          setSaving(false);
          if(reopened){setShiftWorkDate(openedWorkDate);setFinanceDate(openedWorkDate);}
          return;
        }
        rememberTicketShift(sameDayShift as Shift);await loadTicketWorkspace(sameDayShift.id,sameDayShift.venue_id);setPanel("tickets");setSaving(false);
        setMessage("Ngày này đã có một phiên làm việc và phiên đã đóng. Chỉ Chủ sở hữu hoặc Quản lý được mở lại đúng phiên này.");
        return;
      }
      rememberTicketShift(sameDayShift as Shift);await loadTicketWorkspace(sameDayShift.id,sameDayShift.venue_id);setPanel("tickets");setSaving(false);return;
    }
    if(!selectedStaff.length){setSaving(false);setMessage("Chọn ít nhất một nhân sự Loto cho File Vé mới.");return;}
    const { data: shift, error } = await supabase.from("shifts").insert({
      business_id: profile.business_id, venue_id: Number(venueId), name: shiftName.trim(),
      performance_date: openedWorkDate, status: "open", opened_by: session!.user.id,
    }).select("id,name,venue_id,opened_at,opened_by,performance_date,kinh_trung_amount,status").single();
    if (!error && shift) {
      const staffRows = selectedStaff.map((employee_id) => ({ shift_id: shift.id, employee_id, case_mode: "regular", case_amount: 0, allowance: 0 }));
      const { error: staffError } = await supabase.from("shift_staff").upsert(staffRows,{onConflict:"shift_id,employee_id",ignoreDuplicates:true});
      if (!staffError) { rememberTicketShift(shift); setShiftWorkDate(openedWorkDate); setFinanceDate(openedWorkDate); setGameReportDate(openedWorkDate); setKioskPaidDate(openedWorkDate); await loadTicketWorkspace(shift.id); setPanel("tickets"); } else setMessage("Đã tạo ca nhưng chưa lưu đủ nhân sự.");
    } else setMessage(error?.message || "Không thể mở ca làm việc.");
    setSaving(false);
  }

  async function updateShiftStaff() {
    if (!activeShift || ticketReadOnly || selectedStaff.length < 1) return;
    setSaving(true);
    const currentIds = shiftStaff.map(person => person.id);
    const removedIds = currentIds.filter(id => !selectedStaff.includes(id));
    const addedIds = selectedStaff.filter(id => !currentIds.includes(id));
    if (removedIds.length) {
      const { data: usedSales, error: salesError } = await supabase
        .from("ticket_sales")
        .select("employee_id,ticket_round:ticket_rounds!inner(shift_id)")
        .in("employee_id", removedIds)
        .eq("ticket_round.shift_id", activeShift.id)
        .limit(1);
      if (salesError) { setMessage(salesError.message); setSaving(false); return; }
      if (usedSales?.length) {
        setMessage("Không thể bỏ nhân viên đã có số lượng vé trong ca. Hãy xóa số lượng vé của nhân viên đó trước rồi thử lại.");
        setSaving(false);
        return;
      }
      const { error: deleteError } = await supabase.from("shift_staff").delete().eq("shift_id",activeShift.id).in("employee_id",removedIds);
      if (deleteError) { setMessage(deleteError.message); setSaving(false); return; }
    }
    if (addedIds.length) {
      const { error: insertError } = await supabase.from("shift_staff").upsert(addedIds.map(employee_id => ({shift_id:activeShift.id,employee_id,case_mode:caseMode,case_amount:0,allowance:0})),{onConflict:"shift_id,employee_id",ignoreDuplicates:true});
      if (insertError) { setMessage(insertError.message); setSaving(false); return; }
    }
    await loadTicketWorkspace(activeShift.id,activeShift.venue_id);
    setEditingShiftStaff(false);
    setMessage("Đã cập nhật lại danh sách nhân sự của ca.");
    setSaving(false);
  }

  const overviewStageFinanceSummary=overviewRevenueSelection&&overviewRevenueSelection!=="company"?<section className="overview-stage-finance">
    <div className="overview-finance-section-title"><div><p className="eyebrow">TỔNG HỢP THU CHI</p><h4>{financeVenueName}</h4></div><small>Chỉ tính khoản chi đã duyệt đúng sân khấu đang chọn</small></div>
    <div className="overview-expense-grid">{[["loto","Chi Loto"],["game","Chi Trò Chơi"],["water","Chi Quán Nước"],["kiosk","Chi Kios"],["payroll","Lương Nhân Viên"],["other","Chi Khác"]].map(([category,label])=><article key={category}><span>{label}</span><strong>{Number(expenseByCategory[category]||0).toLocaleString("vi-VN")} đ</strong></article>)}</div>
    <div className="overview-net-summary"><article><span>Tổng Doanh Thu</span><strong>{financeTotalRevenue.toLocaleString("vi-VN")} đ</strong></article><article><span>Tổng Chi Đã Duyệt</span><strong>{financeTotalExpense.toLocaleString("vi-VN")} đ</strong></article><article className={financeRemaining<0?"negative":"positive"}><span>Còn Lại</span><strong>{financeRemaining.toLocaleString("vi-VN")} đ</strong></article></div>
  </section>:null;
  const overviewCompanyFinanceSummary=overviewRevenueSelection==="company"?<section className="overview-stage-finance overview-company-finance">
    <div className="overview-finance-section-title"><div><p className="eyebrow">TỔNG HỢP TOÀN CÔNG TY</p><h4>Thu Chi Công Ty</h4></div><small>Tổng hợp từ cả 4 sân khấu · chỉ tính khoản chi đã duyệt</small></div>
    <div className="overview-company-periods">
      <article><span>Doanh Thu Hôm Nay</span><strong>{overviewCompanyDayRevenue.toLocaleString("vi-VN")} đ</strong></article><article><span>Chi Hôm Nay</span><strong>{overviewCompanyDayExpense.toLocaleString("vi-VN")} đ</strong></article><article className={overviewCompanyDayRevenue-overviewCompanyDayExpense<0?"negative":"positive"}><span>Còn Lại Hôm Nay</span><strong>{(overviewCompanyDayRevenue-overviewCompanyDayExpense).toLocaleString("vi-VN")} đ</strong></article>
      <article><span>Doanh Thu Trong Tuần</span><strong>{overviewCompanyWeekRevenue.toLocaleString("vi-VN")} đ</strong></article><article><span>Chi Trong Tuần</span><strong>{overviewCompanyWeekExpense.toLocaleString("vi-VN")} đ</strong></article><article className={overviewCompanyWeekRevenue-overviewCompanyWeekExpense<0?"negative":"positive"}><span>Còn Lại Trong Tuần</span><strong>{(overviewCompanyWeekRevenue-overviewCompanyWeekExpense).toLocaleString("vi-VN")} đ</strong></article>
    </div>
  </section>:null;

  const overviewTicketVarianceVenues=venues.filter(venue=>(profile?.role!=="manager"||venue.id===profile.venue_id)&&Number(overviewTicketVariances.find(item=>item.venue_id===venue.id)?.mismatch_rounds||0)>0);
  const overviewTicketStockAlerts=overviewTicketStocks.filter(item=>!item.source_configured||item.available_codes<=150||item.stale_codes.length>0);

  const overviewTicketVariancePanel=(profile?.role==="owner"||profile?.role==="manager")&&(
    <section className="overview-ticket-variance" aria-labelledby="ticket-variance-title">
      <header className="overview-ticket-variance-heading">
        <div><p className="eyebrow">ƯU TIÊN KIỂM TRA</p><h2 id="ticket-variance-title">Đối Chiếu File Vé</h2><span>Phát hiện vòng vé không khớp theo đúng từng sân khấu. Bấm vào sân khấu để mở Báo Cáo Vé.</span></div>
        {overviewTicketVarianceLoading&&<span>Đang tự động kiểm tra…</span>}
      </header>
      {overviewTicketStockAlerts.length>0&&<div className="overview-ticket-variance-grid overview-ticket-stock-alerts">
        {overviewTicketStockAlerts.map(item=>{const venue=venues.find(value=>value.id===item.venue_id);return <article className="overview-ticket-variance-card critical-stock-alert" key={"stock-"+item.venue_id}>
          <span className="ticket-variance-status">CẢNH BÁO KHO VÉ</span>
          <strong>{venue?.name||"Sân Khấu"}</strong>
          {!item.source_configured?<b>CHƯA CẤU HÌNH NGUỒN</b>:<>
            {item.available_codes<=150&&<><b>Chỉ còn {item.available_codes} mã vé khả dụng</b><small>Hệ thống tự động cảnh báo khi còn không quá 150 mã.</small></>}
            {item.stale_codes.length>0&&<div className="stale-ticket-code-list"><h4>{item.stale_codes.length} mã chưa sử dụng quá 10 ngày</h4>{item.stale_codes.map(code=><p key={code.code}><strong>Mã {code.code}</strong><span>Tồn {code.quantity} vé</span><b>{code.days_unused} ngày</b></p>)}</div>}
          </>}
        </article>})}
      </div>}
      <div className="overview-ticket-variance-grid">
        {overviewTicketVarianceVenues.length===0?<p className="empty-note">Không có vé thiếu, dư hoặc vé lỗi cần xử lý.</p>:overviewTicketVarianceVenues.map(venue=>{
          const row=overviewTicketVariances.find(item=>item.venue_id===venue.id)||{venue_id:venue.id,total_rounds:0,reported_rounds:0,mismatch_rounds:0,surplus_rounds:0,shortage_rounds:0,surplus_tickets:0,shortage_tickets:0,defective_rounds:0,defective_tickets:0};
          const hasVariance=row.mismatch_rounds>0;
          return <button type="button" key={venue.id} className={`overview-ticket-variance-card ${hasVariance?"has-variance":"is-clear"}`} onClick={()=>void openOverviewTicketVariance(venue.id)}>
            <span className="ticket-variance-status">{hasVariance?"CẦN KIỂM TRA":"ĐÃ KHỚP"}</span>
            <strong>{venue.name}</strong>
            <b>{row.mismatch_rounds} vòng chờ xác nhận</b>
            <div><span className="shortage">Thiếu <strong>{row.shortage_rounds} vòng · {row.shortage_tickets} vé</strong></span><span className="surplus">Dư <strong>{row.surplus_rounds} vòng · {row.surplus_tickets} vé</strong></span><span className="defective">Vé Lỗi <strong>{row.defective_rounds} vòng · {row.defective_tickets} vé</strong></span></div>
            <small>Đã đối chiếu {row.reported_rounds}/{row.total_rounds} vòng · Mở Báo Cáo Vé →</small>
          </button>;
        })}
      </div>
    </section>
  );
  const overviewRewardSummary=overviewRevenueSelection&&overviewRevenueSelection!=="company"?(
    overviewBonusVenueKey.includes("go an lac")?
      <section className="bonus-summary go-an-lac-bonus">
        <label className="bonus-responsible-picker">Nhân Sự Phụ Trách
          <select value={bonusResponsibleEmployeeId} onChange={event=>void saveBonusResponsibleEmployee(bonusResponsibleVenueId,event.target.value)}>
            <option value="">Chọn Nhân Sự Loto</option>
            {ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}
          </select>
        </label>
        <div className="bonus-heading"><div><strong>Doanh thu Loto từng phiên từ 10.000.000 đ được thưởng 10%</strong></div><div><small>Doanh Thu Loto Phiên</small><strong>{goAnLacShiftLotoRevenue.toLocaleString("vi-VN")} đ</strong></div></div>
        <div className="bonus-kpis"><div><span>Điều Kiện</span><b>{goAnLacShiftLotoRevenue>=10000000?"Đạt":"Chưa Đạt"}</b></div><div><span>Tỷ Lệ Thưởng</span><b>10%</b></div><div><span>Thưởng Đặc Biệt Ghi Nhận</span><b>{goAnLacBonus.toLocaleString("vi-VN")} đ</b></div></div>
      </section>:
      <section className="overview-revenue-detail card overview-bonus-card">
        <div className="overview-revenue-detail-heading"><div><p className="eyebrow">TỔNG KẾT THƯỞNG LOTO</p><h3>Thưởng Nhân Sự Phụ Trách · {overviewBonusVenueName}</h3><small>Quỹ tháng 5.000.000 đ; mỗi tuần không đạt trừ 500.000 đ.</small></div></div>
        <div className="overview-bonus-inline">
          <label className="overview-bonus-person"><span>Nhân Sự Phụ Trách</span><select value={bonusResponsibleEmployeeId} onChange={event=>void saveBonusResponsibleEmployee(bonusResponsibleVenueId,event.target.value)}><option value="">Chọn Nhân Sự Loto</option>{ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>
          <div><span>Quỹ Thưởng Tháng</span><strong>5.000.000 đ</strong></div><div><span>Mục Tiêu Theo Sân Khấu</span><strong>{overviewBonusTarget.toLocaleString("vi-VN")} đ / Tuần</strong></div><div><span>Tuần Đạt Kế Hoạch</span><strong>{achievedBonusWeeks.length}</strong></div><div><span>Tuần Không Đạt</span><strong>{missedBonusWeeks} × 500.000 đ</strong></div>{responsibilityOffEligible&&<div><span>OFF Trong Tháng</span><strong>{responsibilityOffDays} ngày · Miễn 2 ngày</strong></div>}{responsibilityOffEligible&&<div><span>OFF Vượt Quy Định</span><strong>{responsibilityExcessOffDays} × 500.000 đ</strong></div>}<div><span>Đã Ứng Thưởng</span><strong>{responsibleApprovedAdvance.toLocaleString("vi-VN")} đ</strong></div><div><span>Thưởng Còn Lại</span><strong>{monthlyResponsibleBonus.toLocaleString("vi-VN")} đ</strong></div>
        </div>
        <div className="bonus-cycle-note">Chu kỳ tháng {new Date(`${bonusMonth}-01T12:00:00`).toLocaleDateString("vi-VN",{month:"2-digit",year:"numeric"})}: {new Date(`${bonusCycle.start}T12:00:00`).toLocaleDateString("vi-VN")} – {new Date(`${bonusCycle.end}T12:00:00`).toLocaleDateString("vi-VN")}. Chu kỳ bắt đầu vào Thứ Hai và tính hết Chủ Nhật cuối cùng.</div>
        <div className="bonus-weeks overview-bonus-weeks">{periodBonusWeeks.length===0?<p>Chưa có tuần thưởng trong tháng này.</p>:periodBonusWeeks.map(week=>{const achieved=Number(week.weekly_revenue||0)>=overviewBonusTarget;return <article key={week.week_start} className={achieved?"achieved":"not-achieved"}><strong>{new Date(week.week_start+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(week.week_end+"T00:00:00").toLocaleDateString("vi-VN")}</strong><span>{Number(week.weekly_revenue).toLocaleString("vi-VN")} đ / {overviewBonusTarget.toLocaleString("vi-VN")} đ</span><b>{week.week_end>localDateValue()?"Chưa Kết Thúc":achieved?"Đạt":"Không Đạt · Trừ 500.000 đ"}</b></article>})}</div>
      </section>
  ):null;

  const overviewRevenueKpis=<div className="overview-revenue-kpis">
    <article className="overview-total-card"><span>Doanh Thu Hôm Nay</span><strong>{(overviewRevenue?.current.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN"):"Chưa Có Dữ Liệu"}</small></article>
    <article className="overview-comparison"><span>Doanh Thu Hôm Qua</span><strong>{(overviewRevenue?.yesterday.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?new Date(overviewRevenue.yesterdayDate+"T12:00:00").toLocaleDateString("vi-VN"):"Chưa Có Dữ Liệu"}</small></article>
    <article className="overview-week-card"><span>Doanh Thu Trong Tuần</span><strong>{(overviewRevenue?.currentWeek.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?`${new Date(overviewRevenue.weekStart+"T12:00:00").toLocaleDateString("vi-VN")} – ${new Date(overviewRevenue.weekEnd+"T12:00:00").toLocaleDateString("vi-VN")}`:"Thứ Hai đến phiên cuối Chủ Nhật"}</small></article>
    <article className="overview-comparison"><span>Doanh Thu Tuần Trước</span><strong>{(overviewRevenue?.previousWeek.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?new Date(overviewRevenue.previousWeekDate+"T12:00:00").toLocaleDateString("vi-VN"):"Chưa Có Dữ Liệu"}</small></article>
    <article className="overview-month-card"><span>Doanh Thu Trong Tháng</span><strong>{(overviewRevenue?.currentMonth.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?`${new Date(overviewRevenue.monthStart+"T12:00:00").toLocaleDateString("vi-VN")} – ${new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN")}`:"Từ đầu tháng đến ngày đang xem"}</small></article>
  </div>;

  const activeStageOverview=<section className="active-stage-overview">
    <div className="active-stage-title"><div><p className="eyebrow">CA ĐANG HOẠT ĐỘNG</p><h3>Các Sân Khấu Đang Mở File Vé</h3></div><strong>{openVenueShifts.length} Sân Khấu</strong></div>
    {openVenueShifts.length?<div className="active-stage-grid">{openVenueShifts.map(shift=>{const venue=venues.find(item=>item.id===shift.venue_id);const elapsedMs=Math.max(0,Date.now()-new Date(shift.opened_at).getTime());const hours=Math.floor(elapsedMs/3600000);const minutes=Math.floor((elapsedMs%3600000)/60000);return <button type="button" className="active-stage-card" key={shift.id} onClick={()=>void inspectOpenShift(shift)}><span className="active-stage-name">{venue?.name||"Sân Khấu"}</span><span><small>Mở Lúc</small><b>{new Date(shift.opened_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})}</b></span><span><small>Đã Hoạt Động</small><b>{hours} giờ {minutes} phút</b></span><span><small>Người Đang Sử Dụng</small><b>{shift.opened_by?shiftOperatorNames[shift.opened_by]||"Tài Khoản Quản Lý":"Chưa Xác Định"}</b></span><span><small>Nhân Sự Trong Ca</small><b>{shiftStaffCounts[shift.id]||0}</b></span><em>Bấm Để Mở File Vé →</em></button>})}</div>:<div className="active-stage-empty">Hiện không có sân khấu nào đang mở File Vé.</div>}
  </section>;

  const reportableReportRounds=reportRounds.filter(round=>{const current=ticketRoundReconciliation(round);return current.activeCodes.length>0&&current.hasSale;});
  const validReportedRounds=reportableReportRounds.filter(round=>ticketRoundReconciliation(round).hasValidReport);
  const mismatchedReportRounds=validReportedRounds.filter(round=>ticketRoundReconciliation(round).hasOutstandingVariance);
  const showTicketVarianceOnly=reportVarianceOnly||(panel==="ticketReport"&&moduleSection==="Tổng Quan");
  const visibleReportRounds=showTicketVarianceOnly?mismatchedReportRounds:reportableReportRounds;
  const kpiReportRounds=showTicketVarianceOnly?visibleReportRounds:reportableReportRounds;
  const ticketHeaderVenue=venues.find(venue=>venue.id===Number(activeShift?.venue_id))?.name||"File Vé";
  const ticketHeaderDate=activeShift?.performance_date||shiftWorkDate||localDateValue();
  const mainHeaderTitle=panel==="tickets"?`${ticketHeaderVenue} · ${new Date(ticketHeaderDate+"T12:00:00").toLocaleDateString("vi-VN")}`:"Gia Đình Tư Hậu Xin Chào";

  if (!ready) return <main className="loading">Đang kết nối hệ thống…</main>;
  if(session&&!profile)return <main className="loading">Đang tải thông tin quyền truy cập…</main>;
  if(session&&profile?.must_change_password)return <main className="first-password-page"><section><Image src="/logo-transparent.png" alt="Gia Đình Tư Hậu" width={220} height={140} /><p className="eyebrow">ĐĂNG NHẬP LẦN ĐẦU</p><h1>Đổi Mật Khẩu Mới</h1><p>Mật khẩu tạm chỉ dùng một lần. Hãy đặt mật khẩu riêng trước khi tiếp tục.</p><label>Mật Khẩu Mới<input type="password" autoComplete="new-password" value={firstPassword} onChange={e=>setFirstPassword(e.target.value)} /></label><label>Nhập Lại Mật Khẩu<input type="password" autoComplete="new-password" value={firstPasswordConfirm} onChange={e=>setFirstPasswordConfirm(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void changeFirstPassword();}} /></label><button disabled={hrSaving} onClick={()=>void changeFirstPassword()}>{hrSaving?"Đang Cập Nhật…":"Xác Nhận Đổi Mật Khẩu"}</button>{message&&<p className="error">{message}</p>}</section></main>;
  if(session&&profile?.role==="manager"&&!managerVenueChosen)return <main className="manager-venue-page"><section><Image src="/logo-transparent.png" alt="Gia Đình Tư Hậu" width={250} height={150}/><p className="eyebrow">PHẠM VI LÀM VIỆC</p><h1>Chọn Sân Khấu Làm Việc</h1><p>Chọn sân khấu đang phụ trách trong phiên này. Toàn bộ File Vé, doanh thu, chi phí và kho sẽ dùng đúng dữ liệu của sân khấu đã chọn.</p><div className="manager-venue-grid">{venues.filter(venue=>venue.is_active!==false).map(venue=><button key={venue.id} disabled={managerVenueLoading} onClick={()=>void chooseManagerVenue(venue.id)}><strong>{venue.name}</strong><span>Vào Làm Việc</span></button>)}</div><small>Có thể đăng xuất và đăng nhập lại để chuyển sang sân khấu khác. Dữ liệu giữa các sân khấu luôn được tách riêng.</small><button className="manager-signout" onClick={()=>void supabase.auth.signOut()}>Đăng Xuất</button>{message&&<p className="error">{message}</p>}</section></main>;

  return <div className={`shell ${!session?"public-shell":""}`} onClick={() => activeMenu && setActiveMenu(null)}>
    <header className="site-header">
      <div className="brand"><Image src="/logo-transparent.png" alt="Lô Tô Show Tư Hậu" width={176} height={112} priority /></div>
      {session && <div className="header-center">
        <div className={`venue-heading ${panel==="tickets"?"ticket-venue-heading":""}`}>{mainHeaderTitle}</div>
        
        <nav aria-label="Điều hướng chính">
          <button className={`nav-link ${panel === "publicHome" ? "active" : ""}`} onClick={() => { setActiveMenu(null); setPanel("publicHome"); void refreshPublicHomepage(); }}>Trang Chủ</button>
          {!isEmployeeOnly&&<button className={`nav-link ${panel === "overview" ? "active" : ""}`} onClick={() => { setModuleSection("Tổng Quan"); setPanel("overview"); }}>Tổng Quan</button>}
          <button className={`nav-link ${panel === "expenseCenter" ? "active" : ""}`} onClick={() => { setActiveMenu(null); setModuleSection("Chi / Ứng Lương"); setPanel("expenseCenter"); }}>{isEmployeeOnly?"Ứng Lương":"Chi / Ứng Lương"}</button>
        {menus.filter(([name])=>!isEmployeeOnly||name==="Nhân Sự Tư Hậu").map(([name]) => <button key={name} className={`nav-link ${moduleSection === name && panel !== "overview" ? "active" : ""}`} onClick={() => openModule(name)}>{name === "Nhân Sự Tư Hậu" ? "Nhân Sự" : name}</button>)}
        </nav>
      </div>}
      <div className="account">{session && profile && (profile.role === "owner" || profile.role === "manager") && <button className="gallery-top-button" onClick={()=>void openPublicAlbumAdmin()}>Hoạt Động Của Đoàn</button>}{session && profile?.role === "owner" && <button className="user-top-button" onClick={()=>void openUserManagement()}>+ Người Dùng</button>}<button className="account-button" onClick={() => session ? void supabase.auth.signOut() : openLoginForm()}>{session ? "Đăng Xuất" : "Đăng Ký / Đăng Nhập"}</button></div>
    </header>

    {session&&panel!=="overview"&&panel!=="publicHome"&&<button className="global-back-button" onClick={()=>window.history.back()} aria-label="Quay lại trang trước">← Quay Lại</button>}

    {!session ? <main className="public-home">
      <section className="public-hero">
        <div className="public-hero-copy"><p className="public-kicker">CHÀO MỪNG ĐẾN VỚI</p><h1>GIA ĐÌNH TƯ HẬU</h1><p>Nơi lưu giữ những khoảnh khắc biểu diễn, hành trình và thành tích nổi bật của đại gia đình Tư Hậu.</p><a href="#public-activity">Hoạt Động Của Đoàn</a></div>
      </section>

      <section className="public-section" id="public-activity"><div className="public-section-heading"><div><p>HOẠT ĐỘNG CỦA ĐOÀN</p><h2>Khoảnh Khắc Nổi Bật</h2></div><span>Ảnh đã được quản lý duyệt công khai</span></div>
        <div className="public-gallery">{publicHighlights.gallery.length>0?publicHighlights.gallery.map((item,index)=><figure key={`${item.image_url}-${index}`}><img className="album-image-backdrop" src={item.image_url} alt="" aria-hidden="true" /><img className="album-image-main" src={item.image_url} alt={item.caption||`Hoạt động Gia Đình Tư Hậu ${index+1}`} /><figcaption>{(item.caption||"Gia Đình Tư Hậu").replace(/^Sân khấu:\s*/i,"")}</figcaption></figure>):<div className="public-gallery-empty"><Image src="/logo-transparent.png" alt="Gia Đình Tư Hậu" width={360} height={230} /><strong>{publicLoading?"Đang Tải Hình Ảnh Hoạt Động…":"Hình Ảnh Hoạt Động Đang Được Cập Nhật"}</strong></div>}</div>
      </section>

      <section className="public-honours public-section"><div className="public-section-heading"><div><p>THÀNH TÍCH NỔI BẬT</p><h2>Bảng Tuyên Dương</h2></div></div><div className="public-honour-grid">
        <article className="public-winners"><h3>Thi Đua Trang Phục</h3>{publicHighlights.costume_winners.length>0?publicHighlights.costume_winners.map(item=><div key={`${item.rank}-${item.name}`}><b className={`public-medal rank-${item.rank}`}>{item.rank===1?"NHẤT":"NHÌ"}</b><span><strong>{item.name}</strong><small>{item.outfits} bộ trang phục · Thưởng {Number(item.reward).toLocaleString("vi-VN")} đ</small></span></div>):<p>Đang cập nhật Nhất/Nhì trang phục tháng.</p>}</article>
        <article className="public-top-five"><h3>Top 5 Điểm Thi Đua</h3>{publicHighlights.top_scores.length>0?publicHighlights.top_scores.map((item,index)=><div key={item.name}><b>#{item.rank||index+1}</b><span>{item.name}</span><strong>{Number(item.points).toLocaleString("vi-VN")} điểm</strong></div>):<p>Đang cập nhật bảng xếp hạng thi đua.</p>}</article>
      </div></section>

      <section className="public-login-section" id="public-login"><div><p className="eyebrow">CỔNG NỘI BỘ</p><h2>Đăng Nhập Hệ Thống</h2><p>Nhân sự đăng nhập để xem nội dung nội bộ và hồ sơ được cấp quyền.</p></div><div className="login-card public-login-card">
        <div className="internal-login"><label>Tên Đăng Nhập<input autoComplete="username" value={loginUsername} onChange={event=>setLoginUsername(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void signInInternal();}} /></label><label>Mật Khẩu<input type="password" autoComplete="current-password" value={loginPassword} onChange={event=>setLoginPassword(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void signInInternal();}} /></label><button className="internal-login-button" disabled={loginLoading} onClick={()=>void signInInternal()}>{loginLoading?"Đang Đăng Nhập…":"Đăng Nhập"}</button></div><div className="login-divider"><span>Hoặc</span></div><button className="google-button" onClick={signIn}><span className="google-mark">G</span> Tiếp Tục Bằng Google</button>{message&&<p className="error" role="alert">{message}</p>}<small>Tài khoản mới cần được chủ sở hữu duyệt trước khi sử dụng.</small>
      </div></section>
      <footer className="public-footer"><strong>GIA ĐÌNH TƯ HẬU</strong><span>Hình ảnh và xếp hạng được công khai phục vụ truyền thông của đoàn.</span></footer>
    </main> : <main className={`main-content ${panel === "tickets" ? "workspace-content" : ""} ${panel === "publicHome" ? "public-view-content" : ""}`} onKeyDownCapture={handleKeyboardNavigation}>
      {message && !historyMode && panel!=="tickets" && <div className="error banner-error">{message}</div>}
      {panel==="overview"&&profile?.status==="active"&&activeStageOverview}
      {profile && profile.status !== "active" ? <section className="card registration"><h2>Đăng ký tài khoản nhân viên</h2><p>Tài khoản đang chờ chủ sở hữu duyệt quyền sử dụng.</p></section> : panel === "publicHome" ?
      <div className="authenticated-public-home"><section className="member-home-hero"><div><p className="public-kicker">CHÀO MỪNG TRỞ LẠI</p><h1>GIA ĐÌNH TƯ HẬU</h1><p>Nơi lưu giữ những khoảnh khắc biểu diễn, hành trình và thành tích nổi bật của đại gia đình Tư Hậu.</p><a href="#member-public-activity">Hoạt Động Của Đoàn</a></div></section>
        <section className="public-section" id="member-public-activity"><div className="public-section-heading"><div><p>HOẠT ĐỘNG CỦA ĐOÀN</p><h2>Khoảnh Khắc Nổi Bật</h2></div><span>Bấm vào ảnh để xem đầy đủ</span></div><div className="public-gallery member-gallery">{publicHighlights.gallery.length>0?publicHighlights.gallery.map((item,index)=><figure key={`${item.image_url}-member-${index}`} onClick={()=>setAlbumLightbox({url:item.image_url,caption:item.caption||"Gia Đình Tư Hậu"})} role="button" tabIndex={0} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")setAlbumLightbox({url:item.image_url,caption:item.caption||"Gia Đình Tư Hậu"});}}><img className="album-image-backdrop" src={item.image_url} alt="" aria-hidden="true" /><img className="album-image-main" src={item.image_url} alt={item.caption||`Hoạt động Gia Đình Tư Hậu ${index+1}`} /><figcaption>{(item.caption||"Gia Đình Tư Hậu").replace(/^Sân khấu:\s*/i,"")}<small>Mở Ảnh</small></figcaption></figure>):<div className="public-gallery-empty"><Image src="/logo-transparent.png" alt="Gia Đình Tư Hậu" width={360} height={230} /><strong>Hình Ảnh Hoạt Động Đang Được Cập Nhật</strong></div>}</div></section>
        <section className="public-honours public-section"><div className="public-section-heading"><div><p>THÀNH TÍCH NỔI BẬT</p><h2>Bảng Tuyên Dương</h2></div></div><div className="public-honour-grid"><article className="public-winners"><h3>Thi Đua Trang Phục</h3>{publicHighlights.costume_winners.length>0?publicHighlights.costume_winners.map(item=><div key={`member-${item.rank}-${item.name}`}><b className={`public-medal rank-${item.rank}`}>{item.rank===1?"NHẤT":"NHÌ"}</b><span><strong>{item.name}</strong><small>{item.outfits} bộ trang phục · Thưởng {Number(item.reward).toLocaleString("vi-VN")} đ</small></span></div>):<p>Đang cập nhật Nhất/Nhì trang phục tháng.</p>}</article><article className="public-top-five"><h3>Top 5 Điểm Thi Đua</h3>{publicHighlights.top_scores.length>0?publicHighlights.top_scores.map((item,index)=><div key={`member-${item.name}`}><b>#{item.rank||index+1}</b><span>{item.name}</span><strong>{Number(item.points).toLocaleString("vi-VN")} điểm</strong></div>):<p>Đang cập nhật bảng xếp hạng thi đua.</p>}</article></div></section>{albumLightbox&&<div className="album-lightbox" role="dialog" aria-modal="true" aria-label="Xem ảnh hoạt động" onClick={()=>setAlbumLightbox(null)}><button aria-label="Đóng ảnh" onClick={()=>setAlbumLightbox(null)}>×</button><div onClick={event=>event.stopPropagation()}><img src={albumLightbox.url} alt={albumLightbox.caption} /><strong>{albumLightbox.caption}</strong></div></div>}</div>
      : panel === "ticketHistory" ?
      <section className="card open-card ticket-file-setup"><div className="ticket-file-setup-heading"><div><p className="eyebrow">LOTO · LỊCH SỬ FILE VÉ</p><h2>Xem Lại File Vé Theo Ngày</h2><p>Chọn đúng sân khấu và ngày cần xem. Dữ liệu lịch sử mở ở chế độ chỉ đọc.</p></div><button onClick={()=>setPanel("overview")}>Quay Lại</button></div><div className="form-grid"><label>Sân Khấu<select value={historyVenueId} onChange={e=>setHistoryVenueId(e.target.value)} disabled={profile?.role==="manager"}><option value="">Chọn Sân Khấu</option>{venues.filter(v=>profile?.role!=="manager"||v.id===profile?.venue_id).map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><label>Ngày Làm Việc<select value={historyDate} onChange={e=>setHistoryDate(e.target.value)}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label></div><div className="actions"><button className="primary" onClick={()=>void loadHistoricalTicket()} disabled={!historyVenueId||!historyDate}>Mở File Vé / Xem Lại</button></div></section>
      : panel === "ticketSetup" ?
      <section className="card open-card ticket-file-setup"><div className="ticket-file-setup-heading"><div><p className="eyebrow">LOTO · FILE VÉ</p><h2>Mở File Vé Theo Ngày Làm Việc</h2><p>Chọn File Vé đang hoạt động để xem, hoặc mở phiên mới nếu sân khấu chưa có người thao tác.</p></div><button onClick={()=>setPanel("overview")}>Quay Lại</button></div>{openVenueShifts.length>0&&<div className="open-shift-list"><div className="open-shift-list-title"><span><i />FILE VÉ ĐANG HOẠT ĐỘNG</span><small>{openVenueShifts.length} sân khấu đang mở</small></div><div className="open-shift-buttons">{openVenueShifts.map(shift=><button key={shift.id} onClick={async()=>{rememberTicketShift(shift);setVenueId(String(shift.venue_id));setShiftWorkDate(shift.performance_date||localDateValue());await loadTicketWorkspace(shift.id,shift.venue_id);setPanel("tickets");}}><span>{venues.find(v=>v.id===shift.venue_id)?.name||"Sân Khấu"}</span><small><b>{shift.performance_date?new Date(shift.performance_date+"T00:00:00").toLocaleDateString("vi-VN"):""}</b><em>Đang hoạt động</em></small><strong aria-hidden="true">→</strong></button>)}</div></div>}<div className="form-grid">
        <label>Sân Khấu<select value={venueId} onChange={(e)=>setVenueId(e.target.value)} disabled={profile?.role==="manager"}><option value="">Chọn Sân Khấu Còn Trống</option>{venues.filter(v=>profile?.role!=="manager"||v.id===profile?.venue_id).map(v=>{const isOpen=openVenueShifts.some(shift=>shift.venue_id===v.id);return <option value={v.id} key={v.id} disabled={isOpen}>{v.name}{isOpen?" — Đang Có File Vé Hoạt Động":""}</option>})}</select></label>
        <label>Ngày Làm Việc<input type="date" value={shiftWorkDate} onChange={(e)=>{setShiftWorkDate(e.target.value);setShiftName(`File Vé ${new Date(e.target.value+"T00:00:00").toLocaleDateString("vi-VN")}`);}} /></label>
        <label>Tên File Vé<input value={shiftName} onChange={(e)=>setShiftName(e.target.value)} /></label>
        <label>Tìm Nhân Sự Loto<input type="search" placeholder="Nhập tên nhân sự" value={search} onChange={(e)=>setSearch(e.target.value)} /></label>
      </div><details className="ticket-staff-dropdown" open><summary><span>Danh Sách Nhân Sự Loto <small>Không giới hạn số người trong File Vé</small></span><strong>{selectedStaff.length} Người Đã Chọn</strong></summary><div className="staff-list">{ticketStaffOptions.filter(employee=>employee.full_name.toLowerCase().includes(search.toLowerCase())).map(employee=><label className={`staff-item ${selectedStaff.includes(employee.id)?"selected":""}`} key={employee.id}><input type="checkbox" checked={selectedStaff.includes(employee.id)} onChange={()=>toggleStaff(employee.id)} />{employee.full_name}</label>)}{ticketStaffOptions.length===0&&<p className="empty-note">Chưa có nhân sự nào được phân loại thuộc bộ phận Loto.</p>}</div></details>
      <div className="actions"><button className="primary" disabled={saving||!venueId||!shiftWorkDate||!shiftName.trim()} onClick={openShift}>{saving?"Đang Mở…":"Mở File Vé / Xem Lại"}</button></div></section>
      : panel === "publicGallery" && (profile?.role==="owner"||profile?.role==="manager") ?
      <section className="public-album-admin card"><div className="album-admin-heading"><div><p className="eyebrow">ALBUM CÔNG KHAI</p><h2>Hoạt Động Của Đoàn</h2><p>{profile.role==="manager"?`Ảnh do bạn gửi được gắn tự động với ${venues.find(venue=>venue.id===profile.venue_id)?.name||"sân khấu đang quản lý"} và xuất hiện trên trang chủ.`:"Xem lại toàn bộ hình ảnh hoạt động do quản lý các sân khấu gửi lên."}</p></div><button onClick={()=>void loadPublicAlbumAdmin()}>Làm Mới</button></div>
        {profile.role==="manager"&&<div className="album-venue-stamp"><span>SÂN KHẤU NGƯỜI GỬI</span><strong>{venues.find(venue=>venue.id===profile.venue_id)?.name||"Chưa Gán Sân Khấu"}</strong><small>Tên sân khấu được hệ thống gắn cố định vào từng ảnh.</small></div>}
        {profile.role==="manager"&&<div className="album-upload-box"><label>Chọn Ảnh Nhân Sự<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event=>setAlbumFiles(Array.from(event.target.files||[]).slice(0,20))} /></label><label>Tiêu Đề / Mô Tả Ảnh<input value={albumCaption} maxLength={200} placeholder="Ví dụ: Nhân sự chuẩn bị trước giờ biểu diễn" onChange={event=>setAlbumCaption(event.target.value)} /></label><button disabled={albumUploading||albumFiles.length===0||!profile.venue_id} onClick={()=>void uploadPublicAlbum()}>{albumUploading?"Đang Tải Và Xuất Bản…":`Gửi Ảnh Lên Trang Chủ${albumFiles.length?` (${albumFiles.length} Ảnh)`:""}`}</button></div>}
        {albumFiles.length>0&&<div className="album-selected-files"><strong>Ảnh Đã Chọn</strong><span>{albumFiles.map(file=>file.name).join(" · ")}</span></div>}
        <div className="album-admin-grid">{publicAlbumItems.length===0?<p className="empty-note">Album chưa có ảnh. Hãy chọn ảnh hoạt động để bắt đầu.</p>:publicAlbumItems.map(item=><figure key={item.id}><img src={`${supabaseUrl}/storage/v1/object/public/public-activity/${item.image_path}`} alt={item.caption||"Hoạt động của đoàn"} /><figcaption><strong>{item.caption||"Hoạt Động Của Đoàn"}</strong><span>{item.is_published?"Đang Công Khai":"Đã Ẩn"}</span></figcaption></figure>)}</div>
      </section> : panel === "users" && profile?.role==="owner" ?
      <section className="user-management card">
        <div className="user-management-heading"><div><p className="eyebrow">QUẢN LÝ TÀI KHOẢN</p><h2>Thêm Người Dùng</h2><p>Mật khẩu được lưu an toàn trong Supabase Auth và không thể xem lại.</p></div><button onClick={()=>void loadUserAccounts()}>Làm Mới</button></div>
        <div className="user-create-grid">
          <label>Tên Đăng Nhập<input autoComplete="off" placeholder="Ví dụ: QuanLyLM" value={newUsername} onChange={event=>setNewUsername(event.target.value.replace(/\s/g,""))} /></label>
          <label>Mật Khẩu<input type="password" autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" value={newUserPassword} onChange={event=>setNewUserPassword(event.target.value)} /></label>
          <label>Tên Hiển Thị<input placeholder="Họ và tên người dùng" value={newUserName} onChange={event=>setNewUserName(event.target.value)} /></label>
          <label>Liên Kết Hồ Sơ Nhân Sự<select value={newUserEmployee} onChange={event=>{setNewUserEmployee(event.target.value);const employee=employees.find(item=>String(item.id)===event.target.value);if(employee)setNewUserName(employee.full_name);}}><option value="">Không Liên Kết</option>{employees.map(employee=><option value={employee.id} key={employee.id}>{employee.full_name}</option>)}</select></label>
          <label>Cấp Quyền<select value={newUserLevel} onChange={event=>setNewUserLevel(event.target.value)}><option value="1">Cấp 1 — Quản Lý Sân Khấu</option><option value="2">Cấp 2 — Trò Chơi + Quán</option><option value="3">Cấp 3 — Không Xem Thu Chi</option></select></label>
          <label>Sân Khấu<select value={newUserVenue} onChange={event=>setNewUserVenue(event.target.value)}><option value="">Chọn Sân Khấu</option>{venues.map(venue=><option value={venue.id} key={venue.id}>{venue.name}</option>)}</select></label>
          <button className="create-user-button" disabled={userSaving} onClick={()=>void createInternalUser()}>{userSaving?"Đang Tạo…":"Tạo Người Dùng"}</button>
        </div>
        <div className="access-level-guide"><article><b>Cấp 1</b><span>Toàn quyền trong đúng sân khấu được giao.</span></article><article><b>Cấp 2</b><span>Xử lý và xem Trò Chơi, Quán Nước.</span></article><article><b>Cấp 3</b><span>Không được xem Doanh Thu và Chi.</span></article></div>
        <div className="user-account-list"><h3>Danh Sách Người Dùng</h3>{userAccounts.map(account=><article key={account.user_id}><div><strong>{account.full_name}</strong><span>{account.username||"Đăng nhập Google"}</span></div><b>{account.role==="owner"?"Chủ Sở Hữu":`Cấp ${account.access_level}`}</b><span>{venues.find(venue=>venue.id===account.venue_id)?.name||"Tất Cả Sân Khấu"}</span><em className={account.status}>{account.status==="active"?"Đang Hoạt Động":"Đã Ngừng Quyền"}</em>{account.role==="owner"?<span className="user-protected">Được Bảo Vệ</span>:account.status==="active"?<button className="delete-user-button" disabled={userSaving} onClick={()=>void disableInternalUser(account)}>Xóa Người Dùng</button>:<span className="user-protected">Đã Xóa Quyền</span>}</article>)}</div>
      </section> : panel === "module" ?
      <section className="module-center card"><div className="module-heading"><p className="eyebrow">PHÂN HỆ QUẢN LÝ</p><h2>{moduleSection}</h2><p>Chỉ hiển thị các chức năng thuộc phân hệ {moduleSection}.</p></div><div className="module-actions">{visibleMenus.find(([name])=>name===moduleSection)?.[1].filter(item=>item!=="Chấm Công"||attendanceEmployees.length>0).map(item=><button key={item} onClick={()=>openMenuItem(item)}><strong>{item}</strong><small>Mở chức năng {item}</small></button>)}</div></section> : panel === "lotoAttendance" ?
      <section className="loto-attendance card"><div className="loto-attendance-heading"><div><p className="eyebrow">QUẢN LÝ KHU LOTO</p><h2>Check In / Check Out</h2><p>Check In trước 18h · Check Out không giới hạn thời gian</p><strong>Người gửi: {employees.find(employee=>employee.id===profile?.employee_id)?.full_name||profile?.username||session?.user.email||"Tài Khoản Đang Đăng Nhập"}</strong></div><div className="loto-attendance-filters"><label>Sân Khấu{profile?.role==="manager"?<input value={venues.find(venue=>venue.id===profile.venue_id)?.name||"Sân Khấu Được Phân Quyền"} readOnly />:<select value={lotoAreaVenueId} onChange={e=>{setLotoAreaVenueId(e.target.value);void loadLotoAreaAttendance(lotoAttendanceDate,e.target.value);}}><option value="">Tất Cả Sân Khấu</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select>}</label><label>Tháng Báo Cáo<select value={lotoAttendanceDate} onChange={e=>{setLotoAttendanceDate(e.target.value);void loadLotoAreaAttendance(e.target.value,lotoAreaVenueId);}}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}{date===localDateValue()?" · Hôm Nay":""}</option>)}</select></label><button className="loto-attendance-refresh" type="button" disabled={lotoAttendanceLoading} onClick={()=>void loadLotoAreaAttendance(lotoAttendanceDate,lotoAreaVenueId)}>{lotoAttendanceLoading?"Đang Tải…":"↻ Làm Mới Báo Cáo"}</button></div></div>
        <div className="loto-attendance-submit"><article><h3>Ảnh Check In</h3><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>selectLotoPhotos("check_in",e.target.files)} /><small>Đã chọn {lotoCheckInPhotos.length}/20 ảnh · Tối đa 10 MB mỗi ảnh</small><div className="loto-photo-preview">{lotoCheckInPhotos.map(file=><img key={`${file.name}-${file.lastModified}`} src={URL.createObjectURL(file)} alt={file.name} />)}</div><label>Lý Do Nếu Check In Trễ<textarea placeholder="Bắt buộc khi gửi sau 18h" value={lotoLateReason} onChange={e=>setLotoLateReason(e.target.value)} /></label><button disabled={!lotoCheckInPhotos.length||lotoAttendanceLoading} onClick={()=>submitLotoAreaPhoto("check_in")}>Gửi {lotoCheckInPhotos.length||""} Ảnh Check In</button></article><article><h3>Ảnh Check Out</h3><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e=>selectLotoPhotos("check_out",e.target.files)} /><small>Đã chọn {lotoCheckOutPhotos.length}/20 ảnh · Tối đa 10 MB mỗi ảnh</small><div className="loto-photo-preview">{lotoCheckOutPhotos.map(file=><img key={`${file.name}-${file.lastModified}`} src={URL.createObjectURL(file)} alt={file.name} />)}</div><p>Không giới hạn giờ Check Out. Ảnh được lưu đúng sân khấu và ngày làm việc.</p><button disabled={!lotoCheckOutPhotos.length||lotoAttendanceLoading} onClick={()=>submitLotoAreaPhoto("check_out")}>Gửi {lotoCheckOutPhotos.length||""} Ảnh Check Out</button></article></div>
        <div className="loto-attendance-history"><h3>Báo Cáo Trong Tháng</h3>{lotoAttendanceRows.length===0?<p className="empty-note">Chưa có báo cáo Check In / Check Out.</p>:lotoAttendanceRows.map(row=><article key={row.id}><div><strong>{row.venue?.name||venues.find(venue=>venue.id===row.venue_id)?.name||"Sân Khấu"} · {new Date(row.work_date+"T00:00:00").toLocaleDateString("vi-VN")}</strong><small>Người gửi: {row.manager?.full_name||"Quản Lý Khu"}</small></div><div className="loto-photo-pair">{(row.check_in_photo_urls||[]).length?(row.check_in_photo_urls||[]).map((url,index)=><a href={url} target="_blank" rel="noreferrer" key={`in-${row.id}-${index}`}><img src={url} alt={`Check In ${index+1}`} loading="lazy" decoding="async" /><span>Check In · Ảnh {index+1} {row.check_in_at?new Date(row.check_in_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"}):""}</span></a>):<span>Chưa Check In</span>}{(row.check_out_photo_urls||[]).length?(row.check_out_photo_urls||[]).map((url,index)=><a href={url} target="_blank" rel="noreferrer" key={`out-${row.id}-${index}`}><img src={url} alt={`Check Out ${index+1}`} loading="lazy" decoding="async" /><span>Check Out · Ảnh {index+1} {row.check_out_at?new Date(row.check_out_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"}):""}</span></a>):<span>Chưa Check Out</span>}</div><div className="loto-review"><b className={row.is_late?"late":"valid"}>{row.is_late?"Check In Trễ":"Hợp Lệ"}</b>{row.late_reason&&<p>Lý do: {row.late_reason}</p>}{row.approval_status==="pending"&&profile?.role==="owner"?<div><button className="reject-action" onClick={()=>reviewLotoLate(row.id,"rejected")}>Không Duyệt</button><button className="approve-action" onClick={()=>reviewLotoLate(row.id,"approved")}>Duyệt Lý Do</button></div>:<small>{row.approval_status==="approved"?"Đã Duyệt Hợp Lệ":row.approval_status==="rejected"?(row.penalty_amount>0?`Vi Phạm Lần ${row.monthly_violation_no} · Phạt ${Number(row.penalty_amount).toLocaleString("vi-VN")} đ`:"Vi Phạm Lần 1 · Đã Nhắc Nhở"):"Không Cần Duyệt"}</small>}</div></article>)}</div>
      </section> : panel === "approvals" ?
      <section className="approval-center card"><div className="finance-heading"><div><p className="eyebrow">TRUNG TÂM XỬ LÝ</p><h2>Duyệt Và Cảnh Báo</h2></div><button onClick={() => loadApprovals()}>Làm Mới</button></div>
        <div className="approval-kpis"><div><small>Chi Chờ Duyệt</small><strong>{pendingExpenses.length}</strong></div><div><small>Off Cần Duyệt</small><strong>{timeOffApprovals.length}</strong></div><div><small>Ứng Lương Chờ Duyệt</small><strong>{salaryAdvanceApprovals.length}</strong></div><div><small>Tổng Cần Xử Lý</small><strong>{approvalCount}</strong></div></div>
        <div className="approval-list"><h3>Khoản Chi Chờ Duyệt</h3>{pendingExpenses.length === 0 ? <p className="empty-note">Không có khoản chi đang chờ.</p> : pendingExpenses.map(item => <article className="approval-row" key={`expense-${item.id}`}><div><strong>{financeCategoryLabel(item.category)} · {Number(item.amount).toLocaleString("vi-VN")} đ</strong><small>{venues.find(v=>v.id===item.venue_id)?.name || "Sân Khấu"} · {new Date(item.entry_date+"T00:00:00").toLocaleDateString("vi-VN")}{item.note ? ` · ${item.note}` : ""}</small></div><div><button className="reject-action" onClick={()=>reviewExpense(item.id,"rejected")}>Từ Chối</button><button className="approve-action" onClick={()=>reviewExpense(item.id,"approved")}>Duyệt</button></div></article>)}
        <h3>Đăng Ký Off Cần Duyệt</h3>{timeOffApprovals.length===0?<p className="empty-note">Không có đăng ký Off cần duyệt.</p>:timeOffApprovals.map(item=><article className="approval-row" key={`off-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"} · {new Date(item.off_date+"T12:00:00").toLocaleDateString("vi-VN")}</strong><small>{item.note?.includes(TIME_OFF_EMERGENCY_NOTE)?"Off Đột Xuất":isVietnamPublicHoliday(item.off_date)?"Off Ngày Lễ Việt Nam":new Date(item.off_date+"T12:00:00").getDay()===6?"Off Thứ Bảy":"Off Chủ Nhật"}</small></div><div><button className="reject-action" onClick={()=>void reviewTimeOff(item.id,"rejected")}>Từ Chối</button><button className="approve-action" onClick={()=>void reviewTimeOff(item.id,"approved")}>Duyệt Off</button></div></article>)}
        <h3>Ứng Lương / Ứng Thưởng Cần Duyệt</h3>{salaryAdvanceApprovals.length===0?<p className="empty-note">Không có đề xuất ứng đang chờ.</p>:salaryAdvanceApprovals.map(item=><article className="approval-row" key={`advance-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"} · {item.request_type==="bonus"?"Ứng Thưởng":"Ứng Lương"} · Đợt {item.installment}</strong><small>{venues.find(venue=>venue.id===item.venue_id)?.name||"Chưa Xác Định Sân Khấu"} · {Number(item.amount||0).toLocaleString("vi-VN")} đ · Tháng {new Date(item.request_month+"T12:00:00").toLocaleDateString("vi-VN",{month:"2-digit",year:"numeric"})}</small></div><div><button className="reject-action" onClick={()=>void reviewSalaryAdvance(item,"rejected")}>Không Duyệt</button><button className="approve-action" onClick={()=>void reviewSalaryAdvance(item,"approved")}>Duyệt & Chuyển Chi</button></div></article>)}
</div>
        <section className="approval-history-center">
          <header><div><p className="eyebrow">LỊCH SỬ TẬP TRUNG</p><h3>Toàn Bộ Yêu Cầu Đã Xử Lý</h3><span>Chi, đăng ký Off, ứng lương/thưởng và thu Kios đã xác nhận.</span></div><div className="approval-history-filter"><label>Ngày Xem Lịch Sử<select value={approvalHistoryDate} onChange={event=>setApprovalHistoryDate(event.target.value)}><option value="">Tất Cả Ngày</option>{approvalHistoryDates.map(date=><option key={date} value={date}>{new Date(date+"T12:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label><b>{filteredApprovalExpenseHistory.length+filteredApprovalTimeOffHistory.length+filteredApprovalAdvanceHistory.length+filteredApprovalKioskHistory.length} mục</b></div></header>
          {approvalHistoryLoading?<p className="empty-note">Đang tải lịch sử duyệt…</p>:<div className="approval-history-groups">
            <article><h4>Khoản Chi <b>{filteredApprovalExpenseHistory.length}</b></h4>{filteredApprovalExpenseHistory.length===0?<p className="empty-note">Không có lịch sử trong ngày đã chọn.</p>:filteredApprovalExpenseHistory.map(item=><div className={`approval-history-row ${item.status}`} key={`history-expense-${item.id}`}><div><strong>{financeCategoryLabel(item.category)} · {Number(item.amount).toLocaleString("vi-VN")} đ</strong><span>{venues.find(venue=>venue.id===item.venue_id)?.name||"Sân Khấu"} · {new Date(item.entry_date+"T12:00:00").toLocaleDateString("vi-VN")}</span><small><b>Nội dung đề xuất:</b> {item.note?.trim()||"Không có diễn giải"}</small></div><em>{item.status==="approved"?"Đã Duyệt":"Không Duyệt"}</em></div>)}</article>
            <article><h4>Đăng Ký Off <b>{filteredApprovalTimeOffHistory.length}</b></h4>{filteredApprovalTimeOffHistory.length===0?<p className="empty-note">Không có lịch sử trong ngày đã chọn.</p>:filteredApprovalTimeOffHistory.map(item=><div className={`approval-history-row ${item.status}`} key={`history-off-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"}</strong><span>Off ngày {new Date(item.off_date+"T12:00:00").toLocaleDateString("vi-VN")}</span>{item.status==="rejected"&&<small>Lý do: {rejectionReasonFromNote(item.note)||"Chưa ghi lý do"}</small>}</div><em>{item.status==="approved"?"Đã Duyệt":"Không Duyệt"}</em></div>)}</article>
            <article><h4>Ứng Lương / Thưởng <b>{filteredApprovalAdvanceHistory.length}</b></h4>{filteredApprovalAdvanceHistory.length===0?<p className="empty-note">Không có lịch sử trong ngày đã chọn.</p>:filteredApprovalAdvanceHistory.map(item=>{const approved=item.status==="approved"||item.status==="sent_to_expense";return <div className={`approval-history-row ${approved?"approved":"rejected"}`} key={`history-advance-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"} · {Number(item.amount).toLocaleString("vi-VN")} đ</strong><span>{item.request_type==="bonus"?"Ứng thưởng":"Ứng lương"} · {venues.find(venue=>venue.id===item.venue_id)?.name||"Sân Khấu"}</span>{!approved&&<small>Lý do: {rejectionReasonFromNote(item.note)||"Chưa ghi lý do"}</small>}</div><em>{approved?"Đã Duyệt":"Không Duyệt"}</em></div>})}</article>
            <article><h4>Thu Kios <b>{filteredApprovalKioskHistory.length}</b></h4>{filteredApprovalKioskHistory.length===0?<p className="empty-note">Không có lịch sử trong ngày đã chọn.</p>:filteredApprovalKioskHistory.map(item=><div className="approval-history-row approved" key={`history-kiosk-${item.id}`}><div><strong>{item.bill?.kiosk?.kiosk_name||`Kios #${item.bill_id}`} · {Number(item.amount).toLocaleString("vi-VN")} đ</strong><span>{venues.find(venue=>venue.id===item.venue_id)?.name||"Sân Khấu"} · {new Date(item.paid_date+"T12:00:00").toLocaleDateString("vi-VN")}</span></div><em>Đã Xác Nhận</em></div>)}</article>
          </div>}
        </section>
      </section> : panel === "gameInventory" ?
      <section className="game-inventory card">
        <div className="game-inventory-heading"><div><p className="eyebrow">KHO VÉ TRÒ CHƠI THEO SÂN KHẤU</p><h2>Nhập Kho Vé Trò Chơi</h2><p>Mỗi sân khấu sử dụng một kho riêng. Dữ liệu của các sân khấu không được dùng chung hoặc trộn lẫn.</p></div><div className="game-inventory-heading-actions"><button disabled={!gameInventoryVenueId||gameInventoryLoading} onClick={()=>void loadGameInventory(gameInventoryVenueId)}>{gameInventoryLoading?"Đang Làm Mới…":"Làm Mới Tồn Kho"}</button><button className="game-inventory-back" onClick={()=>{setPanel("module");setModuleSection("Trò Chơi");}}>← Quay Lại</button></div></div>
        <div className="game-inventory-stage"><strong>Chọn Sân Khấu Cần Nhập Kho</strong><div>{venues.filter(venue=>profile?.role!=="manager"||venue.id===profile.venue_id).map(venue=><button type="button" key={venue.id} className={gameInventoryVenueId===String(venue.id)?"active":""} onClick={()=>{setGameInventoryVenueId(String(venue.id));setGameInventoryDrafts({ticket_10k_quantity:"0",ticket_20k_quantity:"0",inflatable_20k_quantity:"0",nlh_30k_quantity:"0"});void loadGameInventory(String(venue.id));}}>{venue.name}</button>)}</div><small>{gameInventoryVenueId?`Kho đang chọn: ${venues.find(venue=>String(venue.id)===gameInventoryVenueId)?.name||"Sân Khấu"}`:"Chưa chọn sân khấu"}</small></div>
        <div className="game-inventory-grid">{gameInventoryProducts.map(product=>{const productKey=product.key.replace("_quantity","") as GameInventoryRow["product_key"];const stock=gameInventoryRows.find(row=>row.product_key===productKey);return <article key={product.key}><header><strong>{product.label}</strong><span>{product.price.toLocaleString("vi-VN")} đ / Vé</span></header><div className="game-inventory-metric"><small>Tồn Thực Tế Trong Hệ Thống</small><b>{gameInventoryLoading?"…":Number(stock?.quantity_on_hand||0).toLocaleString("vi-VN")}</b><em>{stock?.updated_at?`Cập nhật ${new Date(stock.updated_at).toLocaleString("vi-VN")}`:"Chưa phát sinh nhập kho"}</em></div><label>Số Lượng Bổ Sung<input aria-label={`Số lượng bổ sung ${product.label}`} disabled={!gameInventoryVenueId||gameInventoryLoading||gameInventorySaving} inputMode="numeric" value={gameInventoryDrafts[product.key]} onFocus={event=>event.currentTarget.select()} onChange={event=>setGameInventoryDrafts(current=>({...current,[product.key]:event.target.value.replace(/\D/g,"")}))} onBlur={()=>setGameInventoryDrafts(current=>({...current,[product.key]:current[product.key]||"0"}))} /></label></article>})}</div>
        <div className="game-inventory-summary"><div><span>Sân Khấu</span><strong>{venues.find(venue=>String(venue.id)===gameInventoryVenueId)?.name||"Chưa Chọn"}</strong></div><div><span>Tổng Vé Sắp Nhập</span><strong>{Object.values(gameInventoryDrafts).reduce((sum,value)=>sum+Number(value||0),0).toLocaleString("vi-VN")}</strong></div><button className={gameInventorySaving?"is-saving":Object.values(gameInventoryDrafts).some(value=>Number(value)>0)?"is-ready":""} disabled={!gameInventoryVenueId||gameInventoryLoading||gameInventorySaving||!Object.values(gameInventoryDrafts).some(value=>Number(value)>0)} onClick={()=>void saveGameInventory()}>{gameInventorySaving?"Đang Cộng Vào Kho…":"Cộng Vào Kho"}</button></div>
      </section> : panel === "gameReport" && activeShift ?
      <section className="game-report card"><div className="game-report-heading"><div><p className="eyebrow">DOANH THU TRÒ CHƠI THEO TỪNG LOẠI VÉ</p><h2>{selectedVenueName}</h2><p>Nhập số lượng vé bán; hệ thống tự tính doanh thu và đối chiếu tồn kho đúng sân khấu.</p></div><label className="game-work-date"><small>Ngày Làm Việc Của Ca</small><select value={gameReportDate} onChange={event=>setGameReportDate(event.target.value)}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}{date===localDateValue()?" · Hôm Nay":""}</option>)}</select><span>{gameSaving?"Đang Cập Nhật…":"Có Thể Chọn Ngày Trước"}</span></label></div>
        <div className="game-price-grid">{gameReportProducts.map(product=>{const amount=gameAmounts[product.key];const valid=!amount||Number(amount)%product.price===0;return <article className={valid?"":"invalid"} key={product.key}><header><strong>{product.label}</strong><b>{product.price.toLocaleString("vi-VN")} đ / Vé</b></header><label>Số Lượng Vé<input inputMode="numeric" value={gameQuantities[product.key]} onChange={e=>updateGameQuantity(product.key,e.target.value)} placeholder="Nhập số lượng" /></label><span className="game-convert">⇄</span><label>Thành Tiền<MoneyInput value={amount} onFocus={event=>event.currentTarget.select()} onValueChange={value=>updateGameAmount(product.key,value)} placeholder="Nhập số tiền" /></label>{!valid&&<small>Số tiền phải chia hết cho {product.price.toLocaleString("vi-VN")} đ.</small>}</article>})}</div>
        <div className="game-report-total"><div><small>TỔNG SỐ VÉ</small><strong>{gameProducts.reduce((sum,item)=>sum+Number(gameQuantities[item.key]||0),0).toLocaleString("vi-VN")}</strong></div><div><small>TỔNG DOANH THU TRÒ CHƠI</small><strong>{gameTotalAmount.toLocaleString("vi-VN")} đ</strong></div><button disabled={!gameAmountsValid||gameSaving||!gameTouched} onClick={saveGameReport}>{gameSaving?"Đang Lưu…":gameTouched?"Cập Nhật Báo Cáo":"Đã Cập Nhật"}</button></div>
      </section> : panel === "kioskRevenue" ?
      <section className="kiosk-center card"><div className="kiosk-heading"><div><p className="eyebrow">THU TIỀN KIOS · {kioskVenueName}</p><h2>Điện, Nước Và Phí Theo Tháng</h2><p>Mỗi khoản thu được ghi đúng sân khấu và tự cập nhật vào doanh thu Kios.</p></div><div className="kiosk-period"><label>Sân Khấu<select value={kioskVenueId} onChange={event=>{const selected=event.target.value;setKioskVenueId(selected);setMessage("");resetKioskConfigDraft();void Promise.all([loadKioskConfigs(selected),loadKioskBills(kioskMonth,selected),loadKioskApprovalHistory(kioskMonth,selected)]);}}><option value="">— Chọn Sân Khấu —</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label><label>Kỳ Thu<select value={kioskMonth} onChange={event=>{setKioskMonth(event.target.value);void Promise.all([loadKioskBills(event.target.value,kioskVenueId),loadKioskApprovalHistory(event.target.value,kioskVenueId)]);}}>{Array.from({length:36},(_,index)=>{const date=new Date();date.setDate(1);date.setMonth(date.getMonth()+12-index);const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;return <option key={value} value={value}>Tháng {String(date.getMonth()+1).padStart(2,"0")}/{date.getFullYear()}</option>;})}</select></label><label>Ngày Ghi Nhận<select value={kioskPaidDate} onChange={event=>setKioskPaidDate(event.target.value)}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}{date===localDateValue()?" · Hôm Nay":""}</option>)}</select></label><button className="sheet-sync-button" disabled={kioskSaving} onClick={async()=>{await pullKiosksFromSheet(kioskVenueId);await loadKioskBills(kioskMonth,kioskVenueId);setMessage("Đã đồng bộ danh sách và thông tin Kios từ sheet.");}}>{kioskSaving?"Đang Đồng Bộ…":"Đồng Bộ Từ Sheet"}</button></div></div>
        <nav className="kiosk-workspace-tabs" aria-label="Khu vực quản lý Kios"><button type="button" className={`kiosk-workspace-tab ${kioskWorkspaceTab==="billing"?"active":""}`} style={{padding:"12px 20px",border:"1px solid #8fc9ab",borderRadius:10,background:kioskWorkspaceTab==="billing"?"#0d7650":"#fff",color:kioskWorkspaceTab==="billing"?"#fff":"#075236",fontWeight:900,cursor:"pointer"}} onClick={()=>setKioskWorkspaceTab("billing")}>Lập Hóa Đơn Tháng</button><button type="button" className={`kiosk-workspace-tab ${kioskWorkspaceTab==="contracts"?"active":""}`} style={{padding:"12px 20px",border:"1px solid #8fc9ab",borderRadius:10,background:kioskWorkspaceTab==="contracts"?"#0d7650":"#fff",color:kioskWorkspaceTab==="contracts"?"#fff":"#075236",fontWeight:900,cursor:"pointer"}} onClick={()=>setKioskWorkspaceTab("contracts")}>Hồ Sơ Hợp Đồng</button></nav>
        {kioskWorkspaceTab==="contracts"&&(profile?.role==="owner"||profile?.role==="manager")&&<section className="kiosk-contract-profiles"><header><div><p className="eyebrow">HỒ SƠ HỢP ĐỒNG</p><h3>Điều Khoản Thuê Cố Định</h3><span>Thông tin này chỉ thay đổi khi hợp đồng thay đổi; không nằm trong hóa đơn tháng.</span></div></header>{kioskBills.length===0?<p className="empty-note">Chọn sân khấu và kỳ thu để mở hồ sơ hợp đồng Kios.</p>:<div className="kiosk-bill-grid">{kioskBills.map(bill=>{const draft=kioskDrafts[bill.id];if(!draft)return null;return <article className="kiosk-bill-card" key={`contract-${bill.id}`}><header><h3>{bill.kiosk?.kiosk_name||bill.kiosk?.kiosk_code}</h3><em>Hồ Sơ Hợp Đồng</em></header><div className="kiosk-contract"><h4>Điều Khoản Thuê</h4><div>{([["leaseStart","Ngày Bắt Đầu Thuê","date"],["leaseEnd","Ngày Kết Thúc","date"],["deposit","Tiền Cọc","numeric"],["rent","Giá Thuê Gốc","numeric"],["rentPeriodStart","Giá Thuê Từ Ngày","date"],["rentPeriodEnd","Giá Thuê Đến Ngày","date"],["escalationRate","Tỷ Lệ Trượt Giá (%)","decimal"],["escalationStart","Trượt Giá Từ Ngày","date"],["escalationEnd","Trượt Giá Đến Ngày","date"]] as const).map(([field,label,type])=><label key={field}>{label}{type==="numeric"?<MoneyInput value={draft[field]} onValueChange={value=>updateKioskDraft(bill.id,field,value)} />:<input type={type==="date"?"date":"text"} inputMode={type==="decimal"?"decimal":undefined} value={draft[field]} onChange={e=>updateKioskDraft(bill.id,field,e.target.value)} />}</label>)}</div></div><footer><span>Điều khoản chỉ áp dụng cho Kios này.</span><button disabled={kioskSaving} onClick={()=>void saveKioskContract(bill)}>{kioskSaving?"Đang Lưu…":"Lưu Hồ Sơ Hợp Đồng"}</button></footer></article>})}</div>}</section>}
        {kioskWorkspaceTab==="contracts"&&(profile?.role==="owner"||profile?.role==="manager")&&<section className="kiosk-config-panel">
          <header><div><p className="eyebrow">CẤU HÌNH RIÊNG THEO SÂN KHẤU</p><h3>Danh Sách Kios · {kioskVenueName}</h3><span>Mỗi Kios chỉ thuộc sân khấu đang chọn; lịch sử thu tiền được giữ riêng.</span></div><span className="kiosk-config-count">{kioskConfigs.filter(item=>item.is_active).length} đang hoạt động</span></header>
          {!kioskVenueId?<p className="empty-note">Chọn sân khấu để xem và cấu hình Kios.</p>:<>
            <div className="kiosk-config-form">
              <label>Mã Kios<input value={kioskConfigDraft.code} onChange={event=>setKioskConfigDraft(current=>({...current,code:event.target.value}))} placeholder="VD: QUAY_01" /></label>
              <label>Tên Kios<input value={kioskConfigDraft.name} onChange={event=>setKioskConfigDraft(current=>({...current,name:event.target.value}))} placeholder="Tên người thuê hoặc quầy" /></label>
              <label>Tiền Thuê<MoneyInput value={kioskConfigDraft.rent} onValueChange={value=>setKioskConfigDraft(current=>({...current,rent:value}))} /></label>
              <label>Phí Dịch Vụ<MoneyInput value={kioskConfigDraft.serviceFee} onValueChange={value=>setKioskConfigDraft(current=>({...current,serviceFee:value}))} /></label>
              <label>Tiền Rác<MoneyInput value={kioskConfigDraft.garbageFee} onValueChange={value=>setKioskConfigDraft(current=>({...current,garbageFee:value}))} /></label>
              <label>Phí An Ninh<MoneyInput value={kioskConfigDraft.securityFee} onValueChange={value=>setKioskConfigDraft(current=>({...current,securityFee:value}))} /></label>
              <div className="kiosk-config-actions">{kioskEditingId&&<button className="secondary" onClick={resetKioskConfigDraft}>Hủy Sửa</button>}<button disabled={kioskConfigSaving||!kioskConfigDraft.code.trim()||!kioskConfigDraft.name.trim()} onClick={()=>void saveKioskConfig()}>{kioskConfigSaving?"Đang Lưu…":kioskEditingId?"Lưu Thay Đổi":"+ Thêm Kios"}</button></div>
            </div>
            <div className="kiosk-config-list">{kioskConfigLoading?<p>Đang tải cấu hình…</p>:kioskConfigs.length===0?<p className="empty-note">Sân khấu này chưa có Kios. Nhập thông tin phía trên để thêm mới.</p>:kioskConfigs.map(item=><article className={item.is_active?"":"inactive"} key={item.id}><div><strong>{item.kiosk_name}</strong><span>{item.kiosk_code} · Thuê {Number(item.default_rent||0).toLocaleString("vi-VN")} đ</span></div><em>{item.is_active?"Đang Hoạt Động":"Ngừng Hoạt Động"}</em><button className="secondary" onClick={()=>editKioskConfig(item)}>Sửa</button><button className={item.is_active?"danger-outline":"secondary"} disabled={kioskConfigSaving} onClick={()=>void toggleKioskConfig(item)}>{item.is_active?"Ngừng":"Kích Hoạt"}</button></article>)}</div>
          </>}
        </section>}        {kioskWorkspaceTab==="billing"&&<>{overdueKioskBills.length>0&&<div className="kiosk-alert"><strong>Cảnh Báo Quá Hạn</strong><span>{overdueKioskBills.length} Kios đã qua ngày 10 nhưng chưa ghi nhận đóng tiền.</span></div>}
        <div className="kiosk-bill-grid">{kioskBills.length===0?<div className="empty-note">{kioskSaving?<p>Đang tải danh sách Kios…</p>:<><p>Chưa có dữ liệu Kios cho kỳ thu này.</p><button type="button" onClick={()=>void loadKioskBills(kioskMonth,kioskVenueId)}>Thử Lại</button></>}</div>:kioskBills.map(bill=>{const draft=kioskDrafts[bill.id];if(!draft)return null;const overdue=bill.payment_status==="unpaid"&&bill.due_date<localDateValue();const electric=Math.max(0,(kioskNumber(draft.electricNew)-kioskNumber(draft.electricOld))*5500);const water=Math.max(0,(kioskNumber(draft.waterNew)-kioskNumber(draft.waterOld))*12000);const closing=bill.closing_date;const appliedRate=Number(draft.escalationRate)>0&&(!draft.escalationStart||closing>=draft.escalationStart)&&(!draft.escalationEnd||closing<=draft.escalationEnd)?Number(draft.escalationRate):0;const baseRent=kioskNumber(draft.rent);const effectiveRent=baseRent*(1+appliedRate/100);const total=[draft.serviceFee,draft.garbageFee,draft.securityFee,draft.surcharge,draft.previousDebt].reduce((sum,value)=>sum+kioskNumber(value),effectiveRent)+electric+water;const remainingDebt=Math.max(0,total-kioskNumber(kioskPaymentAmounts[bill.id]||""));return <article className={`kiosk-bill-card${overdue?" overdue":""}`} key={bill.id}>
          <header><div><h3>{bill.kiosk?.kiosk_name||bill.kiosk?.kiosk_code}</h3><div className="kiosk-bill-dates"><label>Ngày Chốt<input type="text" inputMode="numeric" placeholder="dd/mm/yyyy" value={draft.closingDate} onChange={e=>updateKioskDraft(bill.id,"closingDate",e.target.value)} /></label><label>Hạn Đóng<input type="text" inputMode="numeric" placeholder="dd/mm/yyyy" value={draft.dueDate} onChange={e=>updateKioskDraft(bill.id,"dueDate",e.target.value)} /></label></div></div>{bill.payment_status==="paid"?<em>Đã Đóng {bill.paid_date?new Date(bill.paid_date+"T00:00:00").toLocaleDateString("vi-VN"):""}</em>:overdue?<em className="late">Quá Hạn</em>:<em>Chưa Đóng</em>}</header>
          <div className="kiosk-reading-grid"><div className="kiosk-meter"><strong>Điện</strong><label>Số Cũ<input inputMode="numeric" value={draft.electricOld} onChange={e=>updateKioskDraft(bill.id,"electricOld",e.target.value)} /></label><label>Số Mới<input inputMode="numeric" value={draft.electricNew} onChange={e=>updateKioskDraft(bill.id,"electricNew",e.target.value)} /></label><b>{electric.toLocaleString("vi-VN")} đ</b><small>Số cũ tự kế thừa nhưng được phép điều chỉnh · × 5.500</small></div><div className="kiosk-meter"><strong>Nước</strong><label>Số Cũ<input inputMode="numeric" value={draft.waterOld} onChange={e=>updateKioskDraft(bill.id,"waterOld",e.target.value)} /></label><label>Số Mới<input inputMode="numeric" value={draft.waterNew} onChange={e=>updateKioskDraft(bill.id,"waterNew",e.target.value)} /></label><b>{water.toLocaleString("vi-VN")} đ</b><small>Số cũ tự kế thừa nhưng được phép điều chỉnh · × 12.000</small></div></div>
          <div className="kiosk-fixed-grid">{([["serviceFee","Phí Dịch Vụ"],["garbageFee","Tiền Rác"],["securityFee","Phí An Ninh"],["surcharge","Phụ Thu"],["previousDebt","Nợ Tháng Trước"]] as const).map(([field,label])=><label key={field}>{label}<MoneyInput value={draft[field]} onValueChange={value=>updateKioskDraft(bill.id,field,value)} /></label>)}<label className="kiosk-note">Ghi Chú<input value={draft.note} onChange={e=>updateKioskDraft(bill.id,"note",e.target.value)} /></label></div>
          <footer><div><small>Còn Phải Thu</small><strong>{Math.max(0,total-Number(bill.paid_amount||0)).toLocaleString("vi-VN")} đ</strong>{Number(bill.paid_amount||0)>0&&<small>Đã thu {Number(bill.paid_amount).toLocaleString("vi-VN")} đ trong tháng</small>}</div><label className="kiosk-paid-amount">Số Tiền Đóng Lần Này<MoneyInput value={kioskPaymentAmounts[bill.id]||""} onValueChange={value=>setKioskPaymentAmounts(current=>({...current,[bill.id]:value}))} /><small>{Math.max(0,total-Number(bill.paid_amount||0)-kioskNumber(kioskPaymentAmounts[bill.id]||"")).toLocaleString("vi-VN")} đ còn lại sau lần đóng này</small></label><button type="button" className="kiosk-export-button" onClick={()=>exportKioskBillImage(bill)}>Xuất Ảnh Hóa Đơn</button><button disabled={kioskSaving||bill.payment_status==="paid"} onClick={()=>kioskPaymentAmounts[bill.id]?markKioskPaid(bill):saveKioskBill(bill)}>{kioskSaving?"Đang Lưu…":"Lưu Thông Tin"}</button>{bill.payment_status!=="paid"&&<button className="paid-button" disabled={kioskSaving||!kioskPaidDate||!kioskPaymentAmounts[bill.id]} onClick={()=>markKioskPaid(bill)}>{kioskSaving?"Đang Xác Nhận…":"Xác Nhận Đã Đóng"}</button>}</footer>
        </article>})}</div></>}
      </section> : panel === "staffManagement" ?
      <section className="staff-management card">
        <div className="staff-module-tabs">
          {(isManagement||(profile?.role==="employee"&&Boolean(profile.employee_id)))&&<button className={personnelTab==="directory"?"active":""} onClick={()=>setPersonnelTab("directory")}>{isManagement?"Danh Sách Nhân Sự":"Gửi Ảnh Thi Đua"}</button>}
          {isManagement&&attendanceEmployees.length>0&&<button className={personnelTab==="attendance"?"active":""} onClick={()=>setPersonnelTab("attendance")}>Chấm Công</button>}
          <button className={personnelTab==="mySchedule"?"active":""} onClick={()=>setPersonnelTab("mySchedule")}>Lịch Của Tôi</button>
          {(isManagement||isLotoScheduleViewer)&&<button className={personnelTab==="schedule"?"active":""} onClick={()=>setPersonnelTab("schedule")}>{isManagement?"Lịch Nhân Sự":"Lịch Toàn Đoàn Loto"}</button>}
          {isManagement&&<button className={personnelTab==="costume"?"active":""} onClick={()=>setPersonnelTab("costume")}>Lịch Trang Phục</button>}
          <button className={personnelTab==="off"?"active":""} onClick={()=>setPersonnelTab("off")}>Đăng Ký Off</button>
          {(isManagement||(profile?.role==="employee"&&Boolean(profile.employee_id)))&&<button className={personnelTab==="competition"?"active":""} onClick={()=>setPersonnelTab("competition")}>Thi Đua Của Tôi</button>}
          {isManagement&&<button className={personnelTab==="payroll"?"active":""} onClick={()=>setPersonnelTab("payroll")}>Hồ Sơ & Lương</button>}
          <button className={personnelTab==="requests"?"active":""} onClick={()=>{setPersonnelTab("requests");void loadRegistrationTracking();}}>Trạng Thái Đề Xuất</button>
          {isManagement&&<button className={personnelTab==="payroll"&&addingEmployee?"active add-employee-tab":"add-employee-tab"} onClick={()=>{setPersonnelTab("payroll");setAddingEmployee(true);}}>+ Thêm Nhân Viên</button>}
        </div>
        {personnelTab==="competition"&&competitionView==="annual"&&renderCompetitionViolationBoard()}
        {personnelTab==="requests"&&<section className="registration-tracking">
          <header className="registration-tracking-heading"><div><p className="eyebrow">THEO DÕI ĐỀ XUẤT</p><h3>Trạng Thái Đề Xuất</h3><span>{profile?.role==="owner"?"Theo dõi trạng thái toàn bộ đề xuất; thao tác duyệt thực hiện tại Tổng Quan":profile?.role==="manager"?"Theo dõi đề xuất thuộc sân khấu đang quản lý; không duyệt tại đây":"Chỉ hiển thị đề xuất của chính bạn"}</span></div><button onClick={()=>void loadRegistrationTracking()} disabled={registrationTrackingLoading}>{registrationTrackingLoading?"Đang Tải…":"Làm Mới"}</button></header>
          <div className="registration-status-legend"><span className="pending">Chưa Xử Lý</span><span className="approved">Đã Duyệt</span><span className="rejected">Không Duyệt</span></div>
          <div className="registration-tracking-columns">
            <article><h4>Đăng Ký Off <b>{trackedTimeOffRequests.length}</b></h4>{trackedTimeOffRequests.length===0?<p className="empty-note">Chưa có đăng ký Off.</p>:trackedTimeOffRequests.map(item=>{const reason=rejectionReasonFromNote(item.note);return <div className={`registration-request ${item.status}`} key={`tracked-off-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"}</strong><span>Off ngày {new Date(item.off_date+"T12:00:00").toLocaleDateString("vi-VN")}</span><small>Gửi lúc {item.created_at?new Date(item.created_at).toLocaleString("vi-VN"):"—"}</small>{item.status==="rejected"&&<em>Lý do: {reason||"Chủ sở hữu chưa ghi lý do"}</em>}</div><aside><b>{item.status==="approved"?"Đã Duyệt":item.status==="rejected"?"Không Duyệt":"Chưa Xử Lý"}</b></aside></div>})}</article>
            <article><h4>Ứng Lương / Ứng Thưởng <b>{trackedSalaryAdvances.length}</b></h4>{trackedSalaryAdvances.length===0?<p className="empty-note">Chưa có đăng ký ứng.</p>:trackedSalaryAdvances.map(item=>{const rejected=item.status==="rejected",approved=item.status==="approved"||item.status==="sent_to_expense";const state=rejected?"rejected":approved?"approved":"pending";const reason=rejectionReasonFromNote(item.note);return <div className={`registration-request ${state}`} key={`tracked-advance-${item.id}`}><div><strong>{item.employee?.full_name||"Nhân Sự"}</strong><span>{item.request_type==="bonus"?"Ứng thưởng":"Ứng lương"} · Đợt {item.installment} · {Number(item.amount||0).toLocaleString("vi-VN")} đ</span><small>Tháng {new Date(item.request_month+"T12:00:00").toLocaleDateString("vi-VN",{month:"2-digit",year:"numeric"})}</small>{rejected&&<em>Lý do: {reason||"Chủ sở hữu chưa ghi lý do"}</em>}</div><aside><b>{rejected?"Không Duyệt":approved?"Đã Duyệt":"Chưa Xử Lý"}</b></aside></div>})}</article>
          </div>
        </section>}
        {(isManagement||isLotoScheduleViewer)&&personnelTab==="schedule"&&renderCompactSchedule()}
        {isManagement&&personnelTab==="payroll"&&<section className="company-hr-panel">
          {(profile?.role==="owner"||profile?.role==="manager")&&addingEmployee&&newEmployeeProfile.department==="loto"&&<div className="loto-case-pay-card"><div><p className="eyebrow">MỨC LƯƠNG BỘ PHẬN LOTO</p><strong>CASE cho hồ sơ mới</strong><small>Hai mức này được dùng tự động theo ngày làm việc trong File Vé.</small></div><label>Lương Ngày Thường<MoneyInput placeholder="Nhập lương ngày thường" value={newEmployeeProfile.weekday_case} onValueChange={value=>setNewEmployeeProfile(row=>({...row,weekday_case:value}))}/></label><label>Lương Thứ 7 & Chủ Nhật<MoneyInput placeholder="Nhập lương cuối tuần" value={newEmployeeProfile.weekend_case} onValueChange={value=>setNewEmployeeProfile(row=>({...row,weekend_case:value}))}/></label></div>}
          {(profile?.role==="owner"||profile?.role==="manager")&&hrSelectedEmployee?.department==="loto"&&<div className="loto-case-pay-card"><div><p className="eyebrow">MỨC LƯƠNG BỘ PHẬN LOTO</p><strong>{hrSelectedEmployee.full_name}</strong><small>Lưu cùng nút “Lưu Hồ Sơ Loto” bên dưới.</small></div><label>Lương Ngày Thường<MoneyInput value={hrSelectedEmployee.weekday_case||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,weekday_case:Number(value)}:row))}/></label><label>Lương Thứ 7 & Chủ Nhật<MoneyInput value={hrSelectedEmployee.weekend_case||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,weekend_case:Number(value)}:row))}/></label></div>}
          {(profile?.role==="owner"||profile?.role==="manager")&&addingEmployee&&<div className="new-employee-profile"><header><div><p className="eyebrow">HỒ SƠ NHÂN SỰ</p><h3>{addingEmployee?"Thêm Nhân Viên Mới":"Nhân Viên"}</h3><small>{profile.role==="manager"?"Hồ sơ được gắn cố định vào sân khấu bạn đang quản lý.":"Chủ sở hữu được chọn sân khấu cho hồ sơ mới."}</small></div></header>{addingEmployee&&<><div className="company-form-grid"><label>Họ Và Tên<input autoFocus value={newEmployeeProfile.full_name} onChange={e=>setNewEmployeeProfile(row=>({...row,full_name:e.target.value}))}/></label><label>Bộ Phận<select value={newEmployeeProfile.department||""} onChange={e=>setNewEmployeeProfile(row=>({...row,department:(e.target.value||"") as Employee["department"]|""}))}><option value="">Chọn Bộ Phận</option><option value="loto">Loto</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option><option value="kiosk">Kios</option><option value="office">Văn Phòng</option></select></label><label>Ngày Vào Làm<input type="date" value={newEmployeeProfile.joined_on} onChange={e=>setNewEmployeeProfile(row=>({...row,joined_on:e.target.value}))}/></label><label>Chức Vụ / Trách Nhiệm<input value={newEmployeeProfile.job_title} onChange={e=>setNewEmployeeProfile(row=>({...row,job_title:e.target.value}))}/></label><label>Loại Lương<select disabled={newEmployeeProfile.department==="loto"} value={newEmployeeProfile.pay_type||""} onChange={e=>setNewEmployeeProfile(row=>({...row,pay_type:(e.target.value||"") as Employee["pay_type"]|""}))}><option value="">{newEmployeeProfile.department==="loto"?"CASE theo File Vé":"Chọn Loại Lương"}</option><option value="monthly">Lương Tháng</option><option value="weekly">Lương Tuần</option><option value="daily">Lương Ngày</option><option value="hourly">Lương Giờ</option></select></label><label>{newEmployeeProfile.pay_type==="weekly"?"Mức Lương Tuần":newEmployeeProfile.pay_type==="daily"?"Mức Lương Ngày Thường":newEmployeeProfile.pay_type==="hourly"?"Lương Giờ Ngày Thường":"Mức Lương Tháng"}<MoneyInput disabled={!newEmployeeProfile.pay_type||newEmployeeProfile.department==="loto"} value={newEmployeeProfile.salary} onValueChange={value=>setNewEmployeeProfile(row=>({...row,salary:value}))}/></label>{newEmployeeProfile.pay_type==="weekly"&&<div className="weekly-pay-policy"><span><small>Chốt lương</small><strong>Chủ Nhật</strong></span><span><small>Nhận lương</small><strong>Thứ Tư</strong></span></div>}{(newEmployeeProfile.pay_type==="hourly"||newEmployeeProfile.pay_type==="daily")&&<><label>{newEmployeeProfile.pay_type==="daily"?"Mức Lương Thứ 7 & Chủ Nhật":"Lương Giờ Cuối Tuần"}<MoneyInput value={newEmployeeProfile.weekend_salary} onValueChange={value=>setNewEmployeeProfile(row=>({...row,weekend_salary:value}))}/></label><label>{newEmployeeProfile.pay_type==="daily"?"Mức Lương Ngày Lễ":"Lương Giờ Ngày Lễ"}<MoneyInput value={newEmployeeProfile.holiday_salary} onValueChange={value=>setNewEmployeeProfile(row=>({...row,holiday_salary:value}))}/></label></>}<label>Mức Thưởng Nhân Viên Giỏi<MoneyInput disabled={newEmployeeProfile.department==="loto"} value={newEmployeeProfile.bonus_amount} onValueChange={value=>setNewEmployeeProfile(row=>({...row,bonus_amount:value}))}/></label><label>Cấp Quyền<select value={newEmployeeProfile.account_access_level} onChange={e=>setNewEmployeeProfile(row=>({...row,account_access_level:Number(e.target.value)}))}><option value="2">Cấp 2</option><option value="3">Cấp 3</option></select></label><label>Sân Khấu<select disabled={profile.role==="manager"} value={profile.role==="manager"?String(profile.venue_id||""):newEmployeeProfile.account_venue_id} onChange={e=>setNewEmployeeProfile(row=>({...row,account_venue_id:e.target.value}))}><option value="">Chọn Sân Khấu</option>{venues.filter(venue=>profile.role!=="manager"||venue.id===profile.venue_id).map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label></div><div className="company-form-actions"><button className="secondary" onClick={()=>setAddingEmployee(false)}>Hủy</button><button disabled={hrSaving||!newEmployeeProfile.full_name.trim()||!newEmployeeProfile.department} onClick={()=>void addCompanyEmployee()}>{hrSaving?"Đang Lưu…":"Lưu Hồ Sơ Mới"}</button></div></>}</div>}
          {(profile?.role==="owner"||profile?.role==="manager")&&hrSelectedEmployee?.department==="loto"&&<div className="loto-employee-form">
            <div className="company-form-heading"><div><p className="eyebrow">NHÂN SỰ LOTO · LƯƠNG NGÀY</p><h3>Hồ Sơ Loto</h3><small>Tiền CASE được tính trực tiếp theo từng ca trong File Làm Việc.</small></div><label>Chọn Nhân Sự<select value={hrSelectedEmployee.id} onChange={e=>setHrEmployeeId(e.target.value)}>{employees.filter(employee=>employee.department==="loto").map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label></div>
            <div className="company-form-grid loto-form-grid">
              <label>Họ Và Tên<input value={hrSelectedEmployee.full_name} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,full_name:e.target.value}:row))}/></label>
              <label>Ngày Vào Làm<input type="date" value={hrSelectedEmployee.joined_on||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,joined_on:e.target.value}:row))}/></label>
              <label>Vai Trò Loto<select value={hrSelectedEmployee.loto_role||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,loto_role:(e.target.value||null) as Employee["loto_role"]}:row))}><option value="">Chọn Vai Trò</option><option value="organ">Đờn Organ</option><option value="ticket_checker">Soát Vé</option><option value="performer">Đào/Kép</option></select></label>
              <label>Chức Vụ / Trách Nhiệm<input value={hrSelectedEmployee.job_title||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,job_title:e.target.value}:row))}/></label>
              <label>Tiền Trách Nhiệm<MoneyInput value={hrSelectedEmployee.responsibility_amount||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,responsibility_amount:Number(value)}:row))}/></label>
              <label>Lương Ngày Thường<MoneyInput value={hrSelectedEmployee.weekday_case||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,weekday_case:Number(value)}:row))}/></label>
              <label>Lương Thứ 7 &amp; Chủ Nhật<MoneyInput value={hrSelectedEmployee.weekend_case||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,weekend_case:Number(value)}:row))}/></label>
              <label>Cấp Quyền<select value={hrSelectedEmployee.account_access_level||3} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,account_access_level:Number(e.target.value)}:row))}><option value="1">Cấp 1</option><option value="2">Cấp 2</option><option value="3">Cấp 3</option></select></label>
              <label>Sân Khấu Phụ Trách<select value={hrSelectedEmployee.account_venue_id||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,account_venue_id:Number(e.target.value)||null}:row))}><option value="">Toàn Công Ty</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label>
              {profile.role==="owner"&&<label>Trạng Thái Tài Khoản<select className="employee-profile-status" value={hrSelectedEmployee.is_active===false?"inactive":"active"} disabled={hrSaving} onChange={event=>{if(event.target.value==="inactive")void deactivateEmployee(hrSelectedEmployee);}}><option value="active">Đang Hoạt Động</option><option value="inactive">Ngưng Hoạt Động</option></select></label>}
              <div className={`bonus-advance-card ${hrSelectedEmployee.bonus_advance_eligible?"enabled":""}`}><strong>Ứng Tiền Thưởng</strong><span>{hrSelectedEmployee.bonus_advance_eligible?`Được ứng tối đa ${Number(hrSelectedEmployee.bonus_advance_limit||0).toLocaleString("vi-VN")} đ`:"Không áp dụng"}</span></div>
            </div>
            {hrSelectedEmployee.responsibility_target_required&&<div className="target-pending-note"><b>Trách nhiệm: 5.000.000 đ/tháng.</b> Điều kiện target doanh thu sẽ được gắn khi chốt công thức.</div>}
            <div className="company-form-actions"><button disabled={hrSaving} onClick={()=>void saveCompanyEmployee(hrSelectedEmployee)}>Lưu Hồ Sơ Loto</button>{profile.role==="owner"&&<button disabled={hrSaving} onClick={()=>void createEmployeeAccount(hrSelectedEmployee)}>Tạo Tài Khoản {employeeUsername(hrSelectedEmployee.full_name)}</button>}</div>
          </div>}
          {(profile?.role==="owner"||profile?.role==="manager")&&hrSelectedEmployee&&<div className="company-employee-form"><div className="company-form-heading"><div><p className="eyebrow">FORM NHẬP DỮ LIỆU ĐẦU VÀO</p><h3>Hồ Sơ Nhân Sự</h3></div><label>Chọn Nhân Sự<select value={hrSelectedEmployee.id} onChange={e=>setHrEmployeeId(e.target.value)}>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label></div><div className="company-form-grid"><label>Họ Và Tên<input value={hrSelectedEmployee.full_name} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,full_name:e.target.value}:row))} /></label><label>Bộ Phận<select value={hrSelectedEmployee.department||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,department:(e.target.value||null) as Employee["department"]}:row))}><option value="">Chọn Bộ Phận</option><option value="loto">Loto</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option><option value="kiosk">Kios</option><option value="office">Văn Phòng</option></select></label><label>Ngày Vào Làm<input type="date" value={hrSelectedEmployee.joined_on||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,joined_on:e.target.value}:row))} /></label><label>Chức Vụ / Trách Nhiệm<input value={hrSelectedEmployee.job_title||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,job_title:e.target.value}:row))} /></label>{hrSelectedEmployee.pay_type==="monthly"&&<><label>Ngày Chốt Công<input type="number" min="1" max="31" value={hrSelectedEmployee.payroll_closing_day||31} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,payroll_closing_day:Number(e.target.value)}:row))} /></label><label>Ngày Nhận Lương<input type="number" min="1" max="31" value={hrSelectedEmployee.salary_payment_day||10} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,salary_payment_day:Number(e.target.value)}:row))} /></label></>}<label>Tiền Trách Nhiệm<MoneyInput value={hrSelectedEmployee.responsibility_amount||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,responsibility_amount:Number(value)}:row))} /></label><label>Loại Lương<select value={hrSelectedEmployee.pay_type||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,pay_type:(e.target.value||null) as Employee["pay_type"]}:row))}><option value="">Chọn Loại Lương</option><option value="monthly">Lương Tháng</option><option value="hourly">Lương Giờ</option><option value="weekly">Lương Tuần</option><option value="daily">Lương Ngày</option></select></label><label>Cấp Quyền<select value={hrSelectedEmployee.account_access_level||3} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,account_access_level:Number(e.target.value)}:row))}><option value="1">Cấp 1</option><option value="2">Cấp 2</option><option value="3">Cấp 3</option></select></label><label>Sân Khấu Phụ Trách<select value={hrSelectedEmployee.account_venue_id||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,account_venue_id:Number(e.target.value)||null}:row))}><option value="">Toàn Công Ty</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label><label>{hrSelectedEmployee.pay_type==="weekly"?"Mức Lương Tuần":hrSelectedEmployee.pay_type==="daily"?"Mức Lương Ngày Thường":hrSelectedEmployee.pay_type==="hourly"?"Lương Giờ Ngày Thường":"Mức Lương Tháng"}<MoneyInput value={hrSelectedEmployee.pay_type==="monthly"?hrSelectedEmployee.monthly_salary||"":hrSelectedEmployee.pay_type==="weekly"?hrSelectedEmployee.weekly_salary||"":hrSelectedEmployee.pay_type==="daily"?hrSelectedEmployee.daily_rate||"":hrSelectedEmployee.hourly_rate||""} onValueChange={digits=>{const value=Number(digits);setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,...(hrSelectedEmployee.pay_type==="monthly"?{monthly_salary:value}:hrSelectedEmployee.pay_type==="weekly"?{weekly_salary:value}:hrSelectedEmployee.pay_type==="daily"?{daily_rate:value}:{hourly_rate:value})}:row));}} /></label>{hrSelectedEmployee.pay_type==="weekly"&&<div className="weekly-pay-policy"><span><small>Chốt lương</small><strong>Chủ Nhật</strong></span><span><small>Nhận lương</small><strong>Thứ Tư</strong></span></div>}{hrSelectedEmployee.pay_type==="daily"&&<><label>Mức Lương Thứ 7 & Chủ Nhật<MoneyInput value={hrSelectedEmployee.daily_weekend_rate||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,daily_weekend_rate:Number(value)}:row))} /></label><label>Mức Lương Ngày Lễ<MoneyInput value={hrSelectedEmployee.daily_holiday_rate||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,daily_holiday_rate:Number(value)}:row))} /></label></>}{hrSelectedEmployee.pay_type==="hourly"&&<><label>Lương Giờ Cuối Tuần<MoneyInput value={hrSelectedEmployee.weekend_hourly_rate||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,weekend_hourly_rate:Number(value)}:row))} /></label><label>Lương Giờ Ngày Lễ<MoneyInput value={hrSelectedEmployee.holiday_hourly_rate||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,holiday_hourly_rate:Number(value)}:row))} /></label></>}<label>Mức Thưởng Nhân Viên Giỏi<MoneyInput value={hrSelectedEmployee.bonus_amount||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===hrSelectedEmployee.id?{...row,bonus_amount:Number(value)}:row))} /></label></div><div className="company-form-actions"><button disabled={hrSaving} onClick={()=>void saveCompanyEmployee(hrSelectedEmployee)}>Lưu Hồ Sơ Nhân Sự</button>{profile.role==="owner"&&<button disabled={hrSaving} onClick={()=>void createEmployeeAccount(hrSelectedEmployee)}>Tạo Tài Khoản {employeeUsername(hrSelectedEmployee.full_name)}</button>}</div></div>}
          {(profile?.role==="owner"||profile?.role==="manager")&&<div className="company-employee-table"><table><thead><tr><th>Họ Và Tên</th><th>Bộ Phận</th><th>Ngày Vào Làm</th><th>Chốt Công</th><th>Nhận Lương</th><th>Trách Nhiệm</th><th>Thưởng</th><th>Loại Lương</th><th>Mức Lương</th><th>Cấp Quyền</th><th>Sân Khấu</th><th>Trạng Thái</th><th></th></tr></thead><tbody>{payrollDepartmentGroups.flatMap(group=>[<tr className={`employee-department-row department-${group.key}`} key={`department-${group.key}`}><td colSpan={13}><strong>{group.label}</strong><span>{group.employees.length} nhân sự</span></td></tr>,...group.employees.map(employee=><tr key={employee.id}><td><input value={employee.full_name} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,full_name:e.target.value}:row))} /></td><td><select value={employee.department||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,department:(e.target.value||null) as Employee["department"]}:row))}><option value="">Chọn</option><option value="loto">Loto</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option><option value="kiosk">Kios</option><option value="office">Văn Phòng</option></select></td><td><input type="date" value={employee.joined_on||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,joined_on:e.target.value}:row))} /></td><td>{employee.pay_type==="weekly"?<strong>Chủ Nhật</strong>:employee.pay_type!=="monthly"?<span aria-label="Không áp dụng">—</span>:<input type="number" min="1" max="31" value={employee.payroll_closing_day||31} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,payroll_closing_day:Number(e.target.value)}:row))} />}</td><td>{employee.pay_type==="weekly"?<strong>Thứ Tư</strong>:employee.pay_type!=="monthly"?<span aria-label="Không áp dụng">—</span>:<input type="number" min="1" max="31" value={employee.salary_payment_day||10} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,salary_payment_day:Number(e.target.value)}:row))} />}</td><td><MoneyInput value={employee.responsibility_amount||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,responsibility_amount:Number(value)}:row))} /></td><td><MoneyInput value={employee.bonus_amount||""} onValueChange={value=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,bonus_amount:Number(value)}:row))} /></td><td><select value={employee.pay_type||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,pay_type:(e.target.value||null) as Employee["pay_type"]}:row))}><option value="">Chọn</option><option value="monthly">Lương Tháng</option><option value="hourly">Lương Giờ</option><option value="weekly">Lương Tuần</option><option value="daily">Lương Ngày</option></select></td><td><MoneyInput value={employee.pay_type==="monthly"?employee.monthly_salary||"":employee.pay_type==="weekly"?employee.weekly_salary||"":employee.pay_type==="daily"?employee.daily_rate||"":employee.hourly_rate||""} onValueChange={digits=>{const value=Number(digits);setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,...(employee.pay_type==="monthly"?{monthly_salary:value}:employee.pay_type==="weekly"?{weekly_salary:value}:employee.pay_type==="daily"?{daily_rate:value}:{hourly_rate:value})}:row));}} /></td><td><select value={employee.account_access_level||3} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,account_access_level:Number(e.target.value)}:row))}><option value="1">Cấp 1</option><option value="2">Cấp 2</option><option value="3">Cấp 3</option></select></td><td><select value={employee.account_venue_id||""} onChange={e=>setEmployees(rows=>rows.map(row=>row.id===employee.id?{...row,account_venue_id:Number(e.target.value)||null}:row))}><option value="">Toàn Công Ty</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></td><td>{profile.role==="owner"?<select className="employee-row-status" value={employee.is_active===false?"inactive":"active"} disabled={hrSaving} onChange={event=>{if(event.target.value==="inactive")void deactivateEmployee(employee);}}><option value="active">Đang Hoạt Động</option><option value="inactive">Ngưng Hoạt Động</option></select>:<span className="employee-status-active">Đang Hoạt Động</span>}</td><td><button disabled={hrSaving} onClick={()=>void saveCompanyEmployee(employee)}>Lưu</button></td></tr>)])}</tbody></table></div>}
          {renderSalaryBalances()}
          {profile?.role==="owner"&&<div className="employee-account-tools"><h3>Cấp Tài Khoản Nhân Sự</h3><p>Tên đăng nhập tự tạo theo họ tên · Mật khẩu tạm <b>123456789</b> · Bắt buộc đổi ở lần đăng nhập đầu tiên.</p><div>{employees.map(employee=><button key={employee.id} disabled={hrSaving} onClick={()=>void createEmployeeAccount(employee)}><strong>{employee.full_name}</strong><span>{employeeUsername(employee.full_name)} · Cấp {employee.account_access_level||3}</span></button>)}</div></div>}
          <div className="salary-advance-area"><article><h3>Đăng Ký Ứng</h3>{profile?.employee_id?<><label>Loại Ứng<select value={advanceType} onChange={e=>setAdvanceType(e.target.value as "salary"|"bonus")}><option value="salary">Ứng Lương</option>{employees.find(item=>item.id===profile.employee_id)?.bonus_advance_eligible&&<option value="bonus">Ứng Tiền Thưởng (Tối Đa 3.000.000 đ)</option>}</select></label><label>Đợt Ứng<select value={advanceInstallment} onChange={e=>setAdvanceInstallment(e.target.value)}><option value="1">Đợt 1 Trong Tháng</option><option value="2">Đợt 2 Trong Tháng</option></select></label><label>Số Tiền<MoneyInput placeholder="Nhập số tiền" value={advanceAmount} onValueChange={setAdvanceAmount} /></label><button disabled={hrSaving||!advanceAmount} onClick={()=>void requestSalaryAdvance()}>Gửi Duyệt Ứng {advanceType==="bonus"?"Thưởng":"Lương"}</button></>:<p>Tài khoản quản lý chưa liên kết hồ sơ nhân sự nên không đăng ký ứng.</p>}</article><article className="salary-advance-list"><h3>Đăng Ký Ứng Trong Tháng</h3>{salaryAdvances.length===0?<p className="empty-note">Chưa có đăng ký ứng.</p>:salaryAdvances.map(item=><div key={item.id}><span><strong>{item.employee?.full_name||"Nhân Sự"} · {item.request_type==="bonus"?"Ứng Thưởng":"Ứng Lương"} · Đợt {item.installment}</strong><small>{Number(item.amount).toLocaleString("vi-VN")} đ · {item.status==="pending"?"Chờ Duyệt":item.status==="rejected"?"Đã Từ Chối":item.status==="sent_to_expense"?"Đã ChuyỒn Sang Chi":"Đã Duyệt"}</small></span></div>)}</article></div>
        </section>}
        {personnelTab==="mySchedule"&&<section className="my-schedule-panel">
          <header>
            <div><p className="eyebrow">LỊCH DIỄN CÁ NHÂN</p><h3>{employees.find(employee=>employee.id===myScheduleTargetEmployeeId)?.full_name||profile?.username||"Tài Khoản Chưa Liên Kết Nhân Sự"}</h3><span>{canInspectAllSchedules?"Chế độ Admin · Chọn nhân sự để kiểm tra lịch":"Chỉ hiển thị lịch của chính bạn · Không thể chỉnh sửa lịch tại đây"}</span></div>
            <button onClick={()=>void loadMySchedule()} disabled={weeklyScheduleLoading}>{weeklyScheduleLoading?"Đang Tải…":"Làm Mới"}</button>
          </header>
          {canInspectAllSchedules&&<label className="my-schedule-employee-picker">Admin Kiểm Tra Nhân Sự Loto<select value={myScheduleTargetEmployeeId||""} onChange={event=>{const id=Number(event.target.value);setMyScheduleEmployeeId(event.target.value);void loadMySchedule(id);}}>{lotoEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>}
          {!myScheduleTargetEmployeeId?<p className="empty-note">Tài khoản này chưa được liên kết với hồ sơ nhân sự. Vui lòng báo quản lý để liên kết.</p>:<div className="my-schedule-weeks">{[{title:"Tuần Hiện Tại",days:currentWeekDays()},{title:"Tuần Kế Tiếp",days:nextWeekDays()}].map(week=><article key={week.title}><div className="my-schedule-week-heading"><strong>{week.title}</strong><span>{new Date(week.days[0].date+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(week.days[6].date+"T00:00:00").toLocaleDateString("vi-VN")}</span></div><div className="my-schedule-days">{week.days.map(day=>{const assignment=mySchedules.find(row=>row.work_date===day.date);const isToday=day.date===localDateValue();return <div key={day.date} className={`${assignment?"assigned":"rest"} ${isToday?"today":""}`}><span>{day.label}</span><strong>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"})}</strong>{assignment?<><b>{assignment.venue?.name||venues.find(venue=>venue.id===assignment.venue_id)?.name||"Đã Xếp Lịch"}</b><small>Có Lịch Diễn</small></>:<><b>Không Có Lịch</b><small>Nghỉ / Chưa Phân Công</small></>}</div>})}</div></article>)}</div>}
        </section>}
        {personnelTab==="directory"&&<><div className="staff-general-folder"><strong>Hình Ảnh Hoạt Động Nhân Sự</strong><span>{profile?.role==="manager"?`Ảnh của ${venues.find(venue=>venue.id===profile.venue_id)?.name||"sân khấu đang quản lý"}`:"Xem lại ảnh nhân sự theo đúng sân khấu gửi lên"}</span>{profile?.role==="manager"&&<button onClick={()=>void openPublicAlbumAdmin()}>Gửi Ảnh Nhân Sự</button>}{profile?.role==="owner"&&<button onClick={()=>void openPublicAlbumAdmin()}>Xem Kho Ảnh</button>}</div>{directoryEmployeeId&&directoryEmployeeView&&(()=>{const employee=employees.find(item=>item.id===directoryEmployeeId);const costume=costumeFields(directoryEmployeeId);const score=scoreFields(directoryEmployeeId);const annual=annualScores[directoryEmployeeId];const employeeSubmissions=costumeSubmissions.filter(item=>item.employee_id===directoryEmployeeId);return <section className="directory-employee-detail"><header><div><p className="eyebrow">{directoryEmployeeView==="costume"?"NHẬT KÝ TRANG PHỤC":"BẢNG ĐÁNH GIÁ"}</p><h3>{employee?.full_name||"Nhân Sự"}</h3><span>Chỉ hiển thị dữ liệu của nhân sự đang chọn</span></div>{profile?.role!=="employee"&&<button onClick={()=>{setDirectoryEmployeeId(null);setDirectoryEmployeeView(null);}}>← Quay Lại Danh Sách</button>}</header><nav><button className={directoryEmployeeView==="costume"?"active":""} onClick={()=>setDirectoryEmployeeView("costume")}>Nhật Ký Trang Phục</button><button className={directoryEmployeeView==="evaluation"?"active":""} onClick={()=>setDirectoryEmployeeView("evaluation")}>Bảng Đánh Giá</button></nav>{directoryEmployeeView==="costume"?<><div className="costume-upload-form"><div><strong>Gửi Ảnh Thi Đua — {employee?.full_name}</strong><span>Ngày cập nhật: {new Date(localDateValue()+"T00:00:00").toLocaleDateString("vi-VN")}</span></div><label>Loại Trang Phục<select value={costumeUploadType} onChange={e=>setCostumeUploadType(e.target.value as typeof costumeUploadType)}><option value="ao_dai">Áo Dài</option><option value="dress">Đầm / Vest</option><option value="ba_ba">Bà Ba</option></select></label><label>Chọn Ảnh Thi Đua<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setCostumeUploadFile(e.target.files?.[0]||null)} /></label><button disabled={!costumeUploadFile||costumeUploading} onClick={uploadMyCostume}>{costumeUploading?"Đang Tải Ảnh…":"Gửi Ảnh Thi Đua"}</button></div><div className="directory-costume-history"><h4>Lịch Sử Trong Tháng {scoreMonth.slice(5,7)}/{scoreMonth.slice(0,4)}</h4>{employeeSubmissions.length===0?<p className="empty-note">Nhân sự này chưa có ảnh trang phục trong tháng.</p>:employeeSubmissions.map(item=><article key={item.id}>{item.signed_url&&<img src={item.signed_url} alt="Ảnh trang phục" />}<div><strong>{item.costume_type==="ao_dai"?"Áo Dài":item.costume_type==="dress"?"Đầm / Vest":"Bà Ba"}</strong><span>{new Date(item.submission_date+"T00:00:00").toLocaleDateString("vi-VN")}</span><small>Ghi nhận {item.quantity} bộ</small></div></article>)}</div></>:<div className="directory-evaluation"><article><span>Điểm Tháng</span><strong>{score.remaining_points}/30</strong></article><article><span>Điểm Cộng Dồn Năm</span><strong>{Number(annual?.total_remaining_points||0).toLocaleString("vi-VN")}</strong></article><article><span>Tiền Thưởng Cuối Năm</span><strong>{Number(annual?.payout_amount||0).toLocaleString("vi-VN")} đ</strong></article><article><span>Trang Phục Đã Gửi</span><strong>{costume.total_outfits} bộ</strong></article><article><span>Kết Quả Trang Phục</span><strong>{costume.passed?"Đạt":"Chưa Đạt"}</strong></article><article><span>Tổng Thưởng Trang Phục</span><strong>{costume.total_reward.toLocaleString("vi-VN")} đ</strong></article></div>}</section>})()}{!directoryEmployeeId&&renderEmployeeDirectoryGroups()}</>}
        {personnelTab==="attendance"&&<div className="attendance-panel">
          {(profile?.role==="owner"||profile?.role==="manager")&&<ContractorWeeklyPayroll profile={profile} venues={venues} defaultVenueId={attendanceVenueId||String(profile?.venue_id||"")} onNotice={setMessage} onSubmitted={()=>loadApprovals()} />}
          <div className="attendance-heading"><div><p className="eyebrow">CHẤM CÔNG THEO ĐỊA ĐIỂM</p><h3>Trò Chơi Và Quán Nước</h3><span>Đúng Wi-Fi + trong bán kính GPS · mất kết nối 10 phút tự kết ca</span></div><label>Sân Khấu<select value={attendanceVenueId} onChange={e=>setAttendanceVenueId(e.target.value)}>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label></div>
          {(profile?.role==="owner"||profile?.role==="manager")&&<><div className="attendance-site-config"><div><strong>Cấu Hình Wi-Fi Và GPS Sân Khấu</strong><span>Đứng tại địa điểm, kết nối đúng Wi-Fi rồi bấm lưu.</span></div><label>Bán Kính<input type="number" min="20" max="1000" value={attendanceRadius} onChange={e=>setAttendanceRadius(e.target.value)} /><small>mét</small></label><button disabled={attendanceLoading||!attendanceVenueId} onClick={configureAttendanceSite}>Lưu Vị Trí & Wi-Fi Hiện Tại</button>{(()=>{const venue=venues.find(item=>String(item.id)===attendanceVenueId);return <em className={venue?.attendance_configured_at?"configured":""}>{venue?.attendance_configured_at?`Đã cấu hình · ${venue.attendance_wifi_ips?.length||0} mạng Wi-Fi`:"Chưa cấu hình"}</em>;})()}</div>
          <div className="attendance-employee-config"><h4>Nhân Sự Được Chấm Công</h4>{employees.filter(employee=>employee.department==="game"||employee.department==="water").map(employee=><article key={employee.id}><strong>{employee.full_name}</strong><select value={employee.department||""} onChange={e=>setEmployees(current=>current.map(item=>item.id===employee.id?{...item,department:(e.target.value||null) as Employee["department"]}:item))}><option value="">Không Áp Dụng</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option></select><select value={employee.pay_type||""} onChange={e=>setEmployees(current=>current.map(item=>item.id===employee.id?{...item,pay_type:(e.target.value||null) as Employee["pay_type"]}:item))}><option value="">Chọn Loại Lương</option><option value="monthly">Lương Tháng</option><option value="weekly">Lương Tuần</option><option value="daily">Lương Ngày</option><option value="hourly">Lương Giờ</option></select><input inputMode="numeric" placeholder={employee.pay_type==="monthly"?"Lương Tháng":employee.pay_type==="weekly"?"Lương Tuần":employee.pay_type==="daily"?"Lương Ngày":"Đơn Giá/Giờ"} value={employee.pay_type==="monthly"?employee.monthly_salary||"":employee.pay_type==="weekly"?employee.weekly_salary||"":employee.pay_type==="daily"?employee.daily_rate||"":employee.hourly_rate||""} onChange={e=>{const value=Number(e.target.value.replace(/\D/g,""))||0;setEmployees(current=>current.map(item=>item.id===employee.id?{...item,...(employee.pay_type==="monthly"?{monthly_salary:value}:employee.pay_type==="weekly"?{weekly_salary:value}:employee.pay_type==="daily"?{daily_rate:value}:{hourly_rate:value})}:item));}} /><label className="attendance-enabled"><input type="checkbox" checked={Boolean(employee.attendance_enabled)} onChange={e=>setEmployees(current=>current.map(item=>item.id===employee.id?{...item,attendance_enabled:e.target.checked}:item))} />Bật</label><button disabled={attendanceLoading} onClick={()=>saveAttendanceEmployee(employee)}>Lưu</button></article>)}</div></>}
          {profile?.employee_id&&<div className="attendance-clock-card"><div><span>Nhân Sự</span><strong>{attendanceEmployee?.full_name||employees.find(item=>item.id===profile.employee_id)?.full_name||"Đang Tải"}</strong><small>{attendanceEmployee?.department==="game"?"Trò Chơi":attendanceEmployee?.department==="water"?"Quán Nước":"Chưa Cấu Hình"} · {attendanceEmployee?.pay_type==="monthly"?"Lương Tháng":attendanceEmployee?.pay_type==="hourly"?"Lương Giờ":"Chưa Chọn Loại Lương"}</small></div>{attendanceSession?.status==="active"?<><div><span>Đang Trong Ca</span><strong>{new Date(attendanceSession.checked_in_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})}</strong><small>Tín hiệu gần nhất {new Date(attendanceSession.last_heartbeat_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})}</small></div><button className="attendance-checkout" disabled={attendanceLoading} onClick={()=>attendanceAction("check_out")}>Kết Ca</button></>:<button className="attendance-checkin" disabled={attendanceLoading||!attendanceVenueId} onClick={()=>attendanceAction("check_in")}>Chấm Công Vào</button>}</div>}
        </div>}
        {personnelTab==="schedule"&&<><div className="staff-section-note important-rules"><strong>Lịch Nhân Sự Tuần Kế Tiếp</strong><span>{new Date(nextWeekDays()[0].date+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(nextWeekDays()[6].date+"T00:00:00").toLocaleDateString("vi-VN")} · Xem người đăng ký Off trước khi phân công cả tuần.</span></div><section className="schedule-off-board"><header><div><strong>Nhân Sự Đăng Ký Off Trong Tuần</strong><span>Dữ liệu cập nhật trực tiếp từ mục Đăng Ký Off</span></div><button onClick={()=>void loadTimeOffRequests()} disabled={timeOffLoading}>{timeOffLoading?"Đang Tải…":"Làm Mới"}</button></header><div>{nextWeekDays().map(day=>{const requests=timeOffRequests.filter(row=>row.off_date===day.date&&row.status!=="rejected");return <article key={day.date} className={requests.length?"has-off":""}><strong>{day.label}<small>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"})}</small></strong>{requests.length?<ul>{requests.map(row=><li key={row.id}>{(()=>{const employee=employees.find(item=>item.id===row.employee_id);return <i className={`schedule-level level-${(employee?.scheduling_level||"C").toLowerCase()}`}>{employee?.scheduling_symbol||employee?.scheduling_level||"C"}</i>})()}<b>{row.employee?.full_name||"Nhân Sự"}</b><em className={row.status}>{row.status==="approved"?"Đã Duyệt":"Chờ Duyệt"}</em></li>)}</ul>:<span>Không Có Người Off</span>}</article>})}</div></section><div className="venue-schedule-grid">{venues.map(venue=><article key={venue.id}><strong>{venue.name}</strong><span>Chưa xếp lịch tuần này</span><button className={String(venue.id)===scheduleVenueId?"active":""} onClick={()=>{setScheduleVenueId(String(venue.id));void loadWeeklySchedules(venue.id);}}>Lập Lịch Sân Khấu</button></article>)}</div>{scheduleVenueId&&<section className="weekly-schedule-editor"><header><div><p className="eyebrow">LẬP LỊCH SÂN KHẤU</p><h3>{venues.find(venue=>String(venue.id)===scheduleVenueId)?.name}</h3><span>Toàn bộ nhân sự Loto · Một lịch cho cả tuần</span></div><button onClick={saveWeeklySchedule} disabled={weeklyScheduleLoading}>{weeklyScheduleLoading?"Đang Lưu…":"Lưu Lịch Cả Tuần"}</button></header><div className="weekly-schedule-table"><table><thead><tr><th>Nhân Sự Loto</th>{nextWeekDays().map(day=><th key={day.date}>{day.label}<small>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"})}</small></th>)}</tr></thead><tbody>{lotoEmployees.map(employee=><tr key={employee.id}><td><i className={`schedule-level level-${(employee.scheduling_level||"C").toLowerCase()}`}>{employee.scheduling_symbol||employee.scheduling_level||"C"}</i><strong>{employee.full_name}</strong>{employee.scheduling_note&&<small>{employee.scheduling_note}</small>}</td>{nextWeekDays().map(day=>{const off=timeOffRequests.some(row=>row.employee_id===employee.id&&row.off_date===day.date&&row.status!=="rejected");const assignedVenue=scheduleSelections[`${employee.id}-${day.date}`];const selected=assignedVenue===Number(scheduleVenueId);const otherVenue=assignedVenue&&!selected?venues.find(venue=>venue.id===assignedVenue)?.name:"";return <td key={day.date}><button disabled={off} className={off?"off":selected?"selected":otherVenue?"other-venue":""} onClick={()=>toggleWeeklySchedule(employee.id,day.date)}>{off?"OFF":selected?"Đã Xếp":otherVenue||"Chọn"}</button></td>})}</tr>)}</tbody></table></div><footer><span><b>{Object.values(scheduleSelections).filter(id=>id===Number(scheduleVenueId)).length}</b> lượt phân công trong tuần</span><button onClick={saveWeeklySchedule} disabled={weeklyScheduleLoading}>{weeklyScheduleLoading?"Đang Lưu…":"Lưu Lịch Cả Tuần"}</button></footer></section>}</>}
        {personnelTab==="costume"&&<section className="costume-plan-panel">
          <header><div><p className="eyebrow">TỰ ĐỘNG KHỞI TẠO</p><h3>Lịch Trang Phục Biểu Diễn Tháng {costumePlanMonth.slice(5,7)}/{costumePlanMonth.slice(0,4)}</h3><span>Lịch tháng kế tiếp được tạo tự động; hạn gửi cố định ngày 25 hằng tháng. Có thể chỉnh trực tiếp từng ô trước khi chốt.</span></div><label>Tháng Lịch<select value={costumePlanMonth} onChange={event=>setCostumePlanMonth(event.target.value)}>{Array.from({length:36},(_,index)=>{const date=new Date(new Date().getFullYear()-1,index,1);const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;return <option key={value} value={value}>Tháng {String(date.getMonth()+1).padStart(2,"0")}/{date.getFullYear()}</option>})}</select></label></header>
          <div className="costume-plan-summary"><b>{costumePlan.length} ngày đã khởi tạo</b><span>Mỗi ngày một phương án riêng · Không lặp trang phục trong tháng · Cuối tuần và ngày lễ được đánh dấu bằng màu</span><button onClick={()=>setCostumePlan(generateCostumePlan(costumePlanMonth))}>Khởi Tạo Lại Tháng Này</button></div>
          <details className="costume-plan-review"><summary><span><b>Xem Lại Toàn Bộ Lịch</b><small>Kiểm tra nhanh trước khi chốt và chọn đúng ngày cần điều chỉnh</small></span><strong>{costumePlan.length} ngày</strong></summary><div>{costumePlan.map((item,index)=><article key={'review-'+item.date} className={item.special?"special":""}><header><b>{new Intl.DateTimeFormat("vi-VN",{weekday:"long"}).format(new Date(item.date+"T12:00:00"))}</b><time>{new Date(item.date+"T12:00:00").toLocaleDateString("vi-VN")}</time></header><p><span>Đào</span><strong>{item.dao||"Chưa chọn"}</strong></p><p><span>Kép</span><strong>{item.kep||"Chưa chọn"}</strong></p><button type="button" onClick={()=>{const row=document.getElementById('costume-plan-'+index);row?.scrollIntoView({behavior:"smooth",block:"center"});window.setTimeout(()=>row?.querySelector("input")?.focus(),350);}}>Điều Chỉnh Ngày Này</button></article>)}</div></details>
          <div className="costume-plan-table-wrap"><table className="costume-plan-table"><thead><tr><th>Thứ</th><th>Ngày</th><th>Đào</th><th>Kép</th></tr></thead><tbody>{costumePlan.map((item,index)=>{const weekday=new Intl.DateTimeFormat("vi-VN",{weekday:"long"}).format(new Date(`${item.date}T12:00:00`));return <tr id={`costume-plan-${index}`} key={item.date} className={item.special?"special":""}><td>{weekday}</td><td>{new Date(`${item.date}T12:00:00`).toLocaleDateString("vi-VN")}</td><td><input list="costume-dao-suggestions" value={item.dao} onChange={event=>setCostumePlan(current=>current.map((row,rowIndex)=>rowIndex===index?{...row,dao:event.target.value}:row))} /></td><td><input list="costume-kep-suggestions" value={item.kep} onChange={event=>setCostumePlan(current=>current.map((row,rowIndex)=>rowIndex===index?{...row,kep:event.target.value}:row))} /></td></tr>})}</tbody></table><datalist id="costume-dao-suggestions">{["Đầm ngắn thanh lịch","Đầm dài cổ điển","Đầm công chúa","Đầm hoa","Đầm chữ A","Đầm xếp ly","Đầm dạ hội","Đầm suông","Áo dài trơn bộ","Áo dài họa tiết","Bà ba bộ","Tứ thân"].map(value=><option key={value} value={value} />)}</datalist><datalist id="costume-kep-suggestions">{["Sơ mi trắng","Sơ mi xanh coban","Sơ mi cổ trụ","Sơ mi họa tiết","Sơ mi chữ Y","Sơ mi + ghi lê","Vest đen","Vest xanh","Áo dài trơn bộ","Áo dài khăn đóng","Bà ba bộ","Trang phục công sở"].map(value=><option key={value} value={value} />)}</datalist></div>
          <div className="costume-reference-panel"><div className="costume-reference-heading"><div><p className="eyebrow">HÌNH THAM KHẢO</p><h3>Gợi Ý Trang Phục Tháng {costumePlanMonth.slice(5,7)}</h3><span>Nhân sự mở lịch có thể xem hình để phối trang phục đúng mẫu.</span></div>{(profile?.role==="owner"||profile?.role==="manager")&&<label>Thêm Hình Tham Khảo<input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={event=>setCostumeReferenceFiles(Array.from(event.target.files||[]).slice(0,10))} /><button disabled={costumeReferenceUploading||costumeReferenceFiles.length===0} onClick={()=>void uploadCostumePlanReferences()}>{costumeReferenceUploading?"Đang Tải…":`Tải Hình Lên${costumeReferenceFiles.length?` (${costumeReferenceFiles.length})`:""}`}</button></label>}</div><div className="costume-reference-grid">{costumeReferences.length===0?<p className="empty-note">Chưa có hình tham khảo cho tháng này.</p>:costumeReferences.map((item,index)=><figure key={item.id}>{item.signed_url&&<img src={item.signed_url} alt={`Trang phục tham khảo ${index+1}`} />}<figcaption>Mẫu tham khảo {index+1}</figcaption></figure>)}</div></div>
        </section>}
        {personnelTab==="off"&&(()=>{const registrationEmployeeId=profile?.employee_id||Number(timeOffEmployeeId),windowState=timeOffRegistrationWindow();return <div className="time-off-panel"><div className="staff-section-note important-rules"><strong>Đăng Ký Off Tuần Kế Tiếp</strong><span>{new Date(nextWeekDays()[0].date+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(nextWeekDays()[6].date+"T00:00:00").toLocaleDateString("vi-VN")} · Cổng mở 00:01 Thứ Bảy và khóa sau 12:00 Chủ Nhật.</span></div>{profile?.role==="owner"&&<label className="time-off-employee-picker">Admin Đăng Ký Cho Nhân Sự<select value={timeOffEmployeeId} onChange={e=>{setTimeOffEmployeeId(e.target.value);void loadTimeOffRequests(Number(e.target.value));}}><option value="">Chọn Nhân Sự</option>{employees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label>}{registrationEmployeeId?<><div className={`time-off-window ${windowState.open?"open":"closed"}`}><strong>{windowState.label}</strong><span>{windowState.detail}</span></div><div className="time-off-days">{nextWeekDays().map(day=>{const request=timeOffRequests.find(row=>row.employee_id===registrationEmployeeId&&row.off_date===day.date),selected=selectedOffDates.includes(day.date),requiresApproval=timeOffNeedsApproval(day.date,request?.note);return <button type="button" key={day.date} className={`${selected?"selected":""} ${request?.status||""}`} onClick={()=>toggleOffDate(day.date)} disabled={timeOffLoading||!windowState.open}><strong>{day.label}</strong><span>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"})}</span><small>{request?.status==="approved"?"Đã Duyệt":request&&requiresApproval?"Chờ Duyệt":selected?(requiresApproval?"Sẽ Gửi Duyệt":"Tự Động Hợp Lệ"):(requiresApproval?"Cần Duyệt Khi Chọn":"Không Cần Duyệt")}</small></button>})}</div><div className="time-off-save"><span>Đã chọn <b>{selectedOffDates.length}</b> ngày</span><button disabled={timeOffLoading||!windowState.open} onClick={saveTimeOffRequests}>{timeOffLoading?"Đang Lưu…":windowState.open?"Lưu Đăng Ký Off":"Đã Khóa Đăng Ký"}</button></div><div className="time-off-emergency-action"><div><strong>Xin Off Đột Xuất Hôm Nay</strong><small>Chỉ dùng khi hôm nay chưa có trong lịch Off đã đăng ký của tuần này.</small></div><button disabled={timeOffLoading} onClick={()=>void requestEmergencyOffToday()}>Gửi Duyệt Off Đột Xuất</button></div></>:<p className="empty-note">Hãy chọn nhân sự cần đăng ký Off.</p>}{(profile?.role==="owner"||profile?.role==="manager")&&<div className="time-off-summary"><h3>Danh Sách Đăng Ký Tuần Kế Tiếp</h3>{timeOffRequests.length===0?<p className="empty-note">Chưa có nhân sự đăng ký.</p>:nextWeekDays().map(day=><article key={day.date}><strong>{day.label}<small>{new Date(day.date+"T00:00:00").toLocaleDateString("vi-VN")}</small></strong><span>{timeOffRequests.filter(row=>row.off_date===day.date&&row.status!=="rejected").map(row=>`${row.employee?.full_name||"Nhân Sự"} (${timeOffNeedsApproval(row.off_date,row.note)?row.status==="approved"?"Đã duyệt":"Chờ duyệt":"Tự hợp lệ"})`).join(", ")||"Chưa có đăng ký"}</span></article>)}</div>}</div>})()}
        {personnelTab==="competition"&&<><div className="competition-subtabs"><button className={competitionView==="costume"?"active":""} onClick={()=>setCompetitionView("costume")}>Thi Đua Trang Phục Theo Tháng</button><button className={competitionView==="annual"?"active":""} onClick={()=>setCompetitionView("annual")}>Thi Đua Điểm Cuối Năm</button><label>Tháng Chấm Điểm<select value={scoreMonth} onChange={e=>setScoreMonth(e.target.value)}>{Array.from({length:36},(_,index)=>{const date=new Date(new Date().getFullYear()-1,index,1);const value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;return <option key={value} value={value}>Tháng {String(date.getMonth()+1).padStart(2,"0")}/{date.getFullYear()}</option>})}</select></label></div>{competitionView==="costume"?<><div className="staff-section-note important-rules"><strong>Thi Đua Trang Phục Tính Riêng Theo Tháng</strong><span>Đạt tối thiểu 2 Áo Dài, 2 Đầm/Vest, 1 Bà Ba; gửi đúng ngày và chụp tại sân khấu. Xếp Nhất/Nhì khi có ít nhất 6 người đạt và Top 3 cách nhau tối thiểu 3 bộ.</span><small className="competition-auto-note">Số bộ được tự động tính từ ảnh nhân sự gửi và loại trang phục đã chọn. Nhân viên không được nhập tay; chỉ chủ sở hữu được hiệu chỉnh.</small></div><div className="costume-history"><strong>Nhật Ký Cập Nhật Trong Tháng</strong>{costumeSubmissions.length===0?<span>Chưa có cập nhật trang phục trong tháng này.</span>:costumeSubmissions.map(item=><div key={item.id}><b>{employees.find(employee=>employee.id===item.employee_id)?.full_name||"Nhân Sự"}</b><span>{item.costume_type==="ao_dai"?"Áo Dài":item.costume_type==="dress"?"Đầm / Vest":"Bà Ba"} × {item.quantity}</span><time>{new Date(item.submission_date+"T00:00:00").toLocaleDateString("vi-VN")} · lưu lúc {new Date(item.created_at).toLocaleString("vi-VN")}</time></div>)}</div><div className="competition-table-wrap"><table className="competition-table costume-score-table"><thead><tr><th>Nhân Sự</th><th>Áo Dài</th><th>Đầm / Vest</th><th>Bà Ba</th><th>Tổng Bộ</th><th>Gửi Đúng Ngày</th><th>Chụp Tại Sân Khấu</th><th>Kết Quả</th><th>Xếp Hạng</th><th>Thưởng Đạt</th><th>Thưởng Xếp Hạng</th><th>Tổng Thưởng</th><th>Ghi Chú</th><th></th></tr></thead><tbody>{competitionEmployees.map(employee=>{const row=costumeFields(employee.id);return <tr key={employee.id}><td><strong>{employee.full_name}</strong></td><td><input type="number" min="0" disabled={profile?.role!=="owner"} title={profile?.role==="owner"?"Chủ sở hữu được chỉnh tay":"Tự động tính từ ảnh đã gửi"} value={row.ao_dai_count||""} onChange={e=>updateCostumeField(employee.id,"ao_dai_count",e.target.value)} /></td><td><input type="number" min="0" disabled={profile?.role!=="owner"} title={profile?.role==="owner"?"Chủ sở hữu được chỉnh tay":"Tự động tính từ ảnh đã gửi"} value={row.dress_count||""} onChange={e=>updateCostumeField(employee.id,"dress_count",e.target.value)} /></td><td><input type="number" min="0" disabled={profile?.role!=="owner"} title={profile?.role==="owner"?"Chủ sở hữu được chỉnh tay":"Tự động tính từ ảnh đã gửi"} value={row.ba_ba_count||""} onChange={e=>updateCostumeField(employee.id,"ba_ba_count",e.target.value)} /></td><td>{row.total_outfits}</td><td><input type="checkbox" disabled={profile?.role!=="owner"} checked={row.submitted_on_time} onChange={e=>updateCostumeField(employee.id,"submitted_on_time",e.target.checked)} /></td><td><input type="checkbox" disabled={profile?.role!=="owner"} checked={row.photographed_at_venue} onChange={e=>updateCostumeField(employee.id,"photographed_at_venue",e.target.checked)} /></td><td className={row.passed?"result-ok":"result-error"}>{row.passed?"Đạt":"Chưa Đạt"}</td><td><span className={row.ranking_qualified&&row.rank_position<=2?"rank-badge":""}>{row.ranking_qualified&&row.rank_position===1?"Giải Nhất":row.ranking_qualified&&row.rank_position===2?"Giải Nhì":"—"}</span></td><td>{row.monthly_reward.toLocaleString("vi-VN")} đ</td><td>{row.rank_bonus.toLocaleString("vi-VN")} đ</td><td><strong className="reward-total">{row.total_reward.toLocaleString("vi-VN")} đ</strong></td><td><input disabled={profile?.role!=="owner"} value={row.note||""} onChange={e=>updateCostumeField(employee.id,"note",e.target.value)} /></td><td>{profile?.role==="owner"?<button onClick={()=>saveCostumeScore(employee.id)}>Lưu Chỉnh Sửa</button>:<span className="auto-calculated-badge">Tự động</span>}</td></tr>})}</tbody></table></div></>:<><div className="staff-section-note important-rules"><strong>Thi Đua Điểm Cộng Dồn Đến Cuối Năm</strong><span>Mỗi tháng 30 điểm · Vi phạm trừ điểm · Cuối năm quy đổi 20.000 đ / điểm.</span></div><div className="competition-table-wrap"><table className="competition-table"><thead><tr><th>Nhân Sự</th><th>Điểm Tháng</th><th>Điểm Thưởng</th>{competitionDeductions.map(([,label])=><th key={label}>{label}</th>)}<th>Còn Lại</th><th>Cộng Dồn Năm</th><th>Tiền Cuối Năm</th><th>Thưởng Đặc Biệt</th><th>Ghi Chú</th><th></th></tr></thead><tbody>{competitionEmployees.map(employee=>{const row=scoreFields(employee.id);const annual=annualScores[employee.id];return <tr key={employee.id}><td><strong>{employee.full_name}</strong></td><td className="base-score">30</td><td><input type="number" min="0" value={row.bonus_points||""} onChange={e=>updateScoreField(employee.id,"bonus_points",e.target.value)} /></td>{competitionDeductions.map(([field])=><td key={field}><input type="number" min="0" value={row[field]||""} onChange={e=>updateScoreField(employee.id,field,e.target.value)} /></td>)}<td className="remaining-score">{row.remaining_points}</td><td>{Number(annual?.total_remaining_points||0).toLocaleString("vi-VN")}</td><td>{Number(annual?.payout_amount||0).toLocaleString("vi-VN")} đ</td><td>{employee.id===Number(bonusResponsibleEmployeeId)?goAnLacBonus.toLocaleString("vi-VN"):"0"} đ</td><td><input value={row.note||""} onChange={e=>updateScoreField(employee.id,"note",e.target.value)} /></td><td><button onClick={()=>saveMonthlyScore(employee.id)}>Lưu</button></td></tr>})}</tbody></table></div><div className="reward-installments"><article><strong>Đợt 01</strong><span>Ngày 10/01 năm kế tiếp</span><small>Chi 50% tổng tiền thưởng</small></article><article><strong>Đợt 02</strong><span>Ngày 30/06 năm kế tiếp</span><small>Chi 50% tổng tiền thưởng</small></article><b>Mỗi đợt 50% · Tổng phải trả − Tổng đã chi = Số còn lại</b></div></>}</>}
        {personnelTab==="competition"&&competitionView==="costume"&&<details className="costume-gallery-drawer"><summary>Kho Ảnh Thi Đua <b>{costumeSubmissions.length}</b></summary><section className="costume-photo-gallery"><header><div><p className="eyebrow">ẢNH NHÂN SỰ GỬI</p><h3>Trang Phục Tháng {scoreMonth.slice(5,7)}/{scoreMonth.slice(0,4)}</h3><small>Nhân sự Loto gửi tại tài khoản cá nhân: Nhân Sự → Gửi Ảnh Thi Đua</small></div><span>{costumeSubmissions.length} ảnh</span></header>{costumeSubmissions.length===0?<div className="costume-photo-empty">Chưa có ảnh trang phục được gửi trong tháng này.</div>:<div className="costume-photo-grid">{costumeSubmissions.map(item=>{const employeeName=employees.find(employee=>employee.id===item.employee_id)?.full_name||"Nhân Sự";const costumeLabel=item.costume_type==="ao_dai"?"Áo Dài":item.costume_type==="dress"?"Đầm / Vest":"Bà Ba";const caption=`${employeeName} · ${costumeLabel} · ${new Date(item.submission_date+"T00:00:00").toLocaleDateString("vi-VN")}`;return <article key={`costume-photo-${item.id}`}>{item.signed_url?<button onClick={()=>setAlbumLightbox({url:item.signed_url!,caption})}><img src={item.signed_url} alt={`Ảnh ${costumeLabel} của ${employeeName}`} /><span>Xem Ảnh</span></button>:<div className="costume-photo-missing">Không Có Ảnh</div>}<div><strong>{employeeName}</strong><b>{costumeLabel}</b><time>{new Date(item.submission_date+"T00:00:00").toLocaleDateString("vi-VN")} · {new Date(item.created_at).toLocaleTimeString("vi-VN",{hour:"2-digit",minute:"2-digit"})}</time></div></article>})}</div>}</section></details>}
        {albumLightbox&&personnelTab==="competition"&&<div className="album-lightbox" role="dialog" aria-modal="true" aria-label="Xem ảnh thi đua trang phục" onClick={()=>setAlbumLightbox(null)}><button aria-label="Đóng ảnh" onClick={()=>setAlbumLightbox(null)}>×</button><div onClick={event=>event.stopPropagation()}><img src={albumLightbox.url} alt={albumLightbox.caption} /><strong>{albumLightbox.caption}</strong></div></div>}
        {personnelTab==="competition"&&competitionView==="costume"&&canManageAllCompetition&&<section className="owner-costume-upload"><header><div><p className="eyebrow">GỬI THAY NHÂN SỰ</p><h3>Tải Ảnh Thi Đua Cho Nhân Sự</h3><span>Ảnh được ghi nhận đúng tài khoản nhân viên, đúng sân khấu và tháng hiện tại.</span></div><b>{new Date(localDateValue()+"T00:00:00").toLocaleDateString("vi-VN")}</b></header><div className="owner-costume-upload-grid"><label>Nhân Sự Loto<select value={ownerCostumeEmployeeId} onChange={event=>{const employeeId=event.target.value;setOwnerCostumeEmployeeId(employeeId);const employee=employees.find(item=>item.id===Number(employeeId));setOwnerCostumeVenueId(employee?.account_venue_id?String(employee.account_venue_id):"");}}><option value="">— Chọn đúng tài khoản nhân viên —</option>{lotoEmployees.filter(employee=>employee.is_active!==false).map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><label>Sân Khấu<select value={ownerCostumeVenueId} onChange={event=>setOwnerCostumeVenueId(event.target.value)}><option value="">— Chọn sân khấu chụp ảnh —</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label><label>Loại Trang Phục<select value={ownerCostumeType} onChange={event=>setOwnerCostumeType(event.target.value as typeof ownerCostumeType)}><option value="ao_dai">Áo Dài</option><option value="dress">Đầm / Vest</option><option value="ba_ba">Bà Ba</option></select></label><label>Ảnh Thi Đua<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>setOwnerCostumeFile(event.target.files?.[0]||null)} /></label><button disabled={!ownerCostumeEmployeeId||!ownerCostumeVenueId||!ownerCostumeFile||ownerCostumeUploading} onClick={()=>void uploadOwnerCostume()}>{ownerCostumeUploading?"Đang Gửi Ảnh…":"Gửi Ảnh Cho Nhân Sự"}</button></div></section>}
      </section> : panel === "expenseCenter" ?
      <section className="expense-center-page card">
        <div className="expense-center-hero"><div><p className="eyebrow">CHI PHÍ THEO ĐÚNG SÂN KHẤU</p><h2>{isEmployeeOnly?"Đề Xuất Ứng Lương":"Chi / Ứng Lương"}</h2><p>{isEmployeeOnly?"Gửi đề xuất ứng lương của chính bạn; chủ sở hữu sẽ kiểm tra và duyệt.":"Tách riêng toàn bộ khoản chi Loto, Trò Chơi, Quán Nước, chi khác và tiền lương. Mọi đề xuất đều chuyển về Tổng Quan để chủ sở hữu duyệt."}</p></div><label>Sân Khấu<select disabled={profile?.role!=="owner"} value={resolvedExpenseCenterVenueId||""} onChange={e=>{setExpenseCenterVenueId(e.target.value);setExpenseCenterEmployeeId("");}}><option value="">Chọn sân khấu</option>{venues.filter(venue=>profile?.role!=="owner"?venue.id===resolvedExpenseCenterVenueId:true).map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select><small>{profile?.role==="owner"?"Chủ sở hữu được chọn sân khấu cần xử lý":"Đã khóa theo sân khấu của tài khoản"}</small></label></div>
        <div className="expense-center-form">
          <label>Ngày Ghi Nhận<select value={expenseCenterDate} onChange={e=>setExpenseCenterDate(e.target.value)}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label>
          <label>Bộ Phận<select disabled={isEmployeeOnly} value={expenseCenterCategory} onChange={e=>{setExpenseCenterCategory(e.target.value as typeof expenseCenterCategory);setExpenseCenterEmployeeId("");}}><option value="stage">Sân Khấu</option><option value="loto">Nhân Sự Phụ Trách</option><option value="game">Trò Chơi</option><option value="water">Quán Nước</option><option value="other">Chi Khác</option>{isEmployeeOnly&&<option value="payroll">Lương Nhân Viên</option>}</select></label>
          {expenseCenterSupportsPayroll&&<>{expenseCenterIsPayroll&&<label>Tên Nhân Sự<select disabled={isEmployeeOnly} value={expenseCenterEmployeeId} onChange={e=>setExpenseCenterEmployeeId(e.target.value)}><option value="">— Chọn người nhận tiền —</option>{expenseCenterEmployees.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name} · {employee.department==="game"?"Trò Chơi":employee.department==="water"?"Quán Nước":"Nhân Sự Phụ Trách"}</option>)}</select></label>}<label>Loại Chi<select disabled={isEmployeeOnly} value={expenseCenterPayrollType} onChange={e=>{setExpenseCenterPayrollType(e.target.value as "advance"|"daily"|"weekly"|"monthly"|"other");if(e.target.value==="other")setExpenseCenterEmployeeId("");}}><option value="advance">Ứng Lương</option>{!isEmployeeOnly&&<><option value="daily">Trả Lương Ngày</option><option value="weekly">Trả Lương Tuần</option><option value="monthly">Trả Lương Tháng</option><option value="other">Khác</option></>}</select></label></>}
          <label>Số Tiền<MoneyInput placeholder="Nhập số tiền" value={expenseCenterAmount} onValueChange={setExpenseCenterAmount}/></label>
          <label className="expense-note">Diễn Giải<textarea placeholder="Nhập nội dung chi, lý do hoặc ghi chú cần đối chiếu" value={expenseCenterNote} onChange={e=>setExpenseCenterNote(e.target.value)}/></label>
        </div>
        {expenseCenterIsPayroll&&selectedExpenseEmployee&&<div className="expense-employee-summary"><div><span>Người Nhận Tiền</span><strong>{selectedExpenseEmployee.full_name}</strong></div><div><span>Bộ Phận</span><strong>{selectedExpenseEmployee.department==="game"?"Trò Chơi":selectedExpenseEmployee.department==="water"?"Quán Nước":"Nhân Sự Phụ Trách"}</strong></div><div><span>Loại Lương</span><strong>{selectedExpenseEmployee.pay_type==="monthly"?"Lương Tháng":selectedExpenseEmployee.pay_type==="weekly"?"Lương Tuần":selectedExpenseEmployee.pay_type==="daily"?"Lương Ngày":"Lương Giờ"}</strong></div>{selectedExpenseEmployee.pay_type!=="daily"&&<div><span>Ngày Nhận Lương</span><strong>Ngày {selectedExpenseEmployee.salary_payment_day||10}</strong></div>}</div>}
        <div className="expense-center-submit"><span>{expenseCenterPayrollType==="other"?`Chi khác sẽ trừ đúng doanh thu bộ phận ${expenseCenterCategory==="stage"?"Sân Khấu":expenseCenterCategory==="game"?"Trò Chơi":expenseCenterCategory==="water"?"Quán Nước":"Loto"} của sân khấu đã chọn sau khi duyệt.`:selectedExpenseEmployee?`Khoản chi sẽ ghi cho ${selectedExpenseEmployee.full_name} và trừ đúng phần lương còn lại sau khi được duyệt.`:"Hãy chọn đúng bộ phận và tên nhân sự trước khi gửi duyệt."}</span><button disabled={expenseCenterSaving||!resolvedExpenseCenterVenueId||!expenseCenterAmount||(expenseCenterIsPayroll&&!selectedExpenseEmployee)||(expenseCenterPayrollType==="other"&&!expenseCenterNote.trim())} onClick={()=>void submitExpenseCenterRequest()}>{expenseCenterSaving?"Đang Gửi…":"Gửi Đề Xuất Duyệt"}</button></div>
        {expenseCenterIsPayroll&&<article className="salary-advance-list expense-center-requests"><h3>Đề Xuất Ứng Lương</h3>{salaryAdvances.length===0?<p className="empty-note">Chưa có đề xuất ứng lương.</p>:salaryAdvances.map(item=><div key={item.id}><span><strong>{item.employee?.full_name||"Nhân Sự"} · {item.request_type==="bonus"?"Ứng Thưởng":"Ứng Lương"} · Đợt {item.installment}</strong><small>{Number(item.amount).toLocaleString("vi-VN")} đ · {item.status==="pending"?"Chờ Duyệt":item.status==="rejected"?"Đã Từ Chối":item.status==="sent_to_expense"?"Đã Chuyển Sang Chi":"Đã Duyệt"}</small></span></div>)}</article>}
        {renderFixedExpenseCenter()}
      </section> : panel === "finance" ?
      <section className="finance-center card"><div className="finance-heading"><div><p className="eyebrow">{financeMode==="revenue"?"DOANH THU THEO ĐÚNG SÂN KHẤU":"CHI PHÍ THEO ĐÚNG SÂN KHẤU"}</p><h2>{financeCategory==="all"?`Tổng Quan ${financeVenueName}`:financeMode==="revenue"?`Doanh Thu ${financeCategoryLabel(financeCategory)} · ${financeVenueName}`:`Chi ${financeCategoryLabel(financeCategory)} · ${financeVenueName}`} Theo {financePeriod==="day"?"Ngày":financePeriod==="week"?"Tuần":"Tháng"}</h2></div><label>{financeMode==="revenue"?"Ngày Xem Doanh Thu":"Ngày Xem Chi Phí"}<select value={financeDate} onChange={(e)=>{setFinanceDate(e.target.value);void loadFinance(e.target.value,financePeriod,operationalVenueId);}}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label></div>
        <div className="finance-venue-picker" aria-label="Chọn sân khấu xem thu chi">{venues.filter(venue=>profile?.role!=="manager"||venue.id===profile.venue_id).map(venue=><button key={venue.id} className={operationalVenueId===venue.id?"active":""} aria-pressed={operationalVenueId===venue.id} onClick={()=>{setFinanceVenueOverride(venue.id);setVenueId(String(venue.id));void loadFinance(financeDate,financePeriod,venue.id);}}>{venue.name}</button>)}</div>
        <div className="finance-period"><span>{financeMode==="revenue"?"Xem Doanh Thu Theo":"Xem Chi Phí Theo"}</span>{([['day','Ngày'],['week','Tuần'],['month','Tháng']] as const).map(([value,label])=><button key={value} className={financePeriod===value?"active":""} onClick={()=>{setFinancePeriod(value);void loadFinance(financeDate,value);}}>{label}</button>)}<strong>{new Date(selectedFinanceRange.start+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(selectedFinanceRange.end+"T00:00:00").toLocaleDateString("vi-VN")}</strong></div>
        {financeCategory==="all"?<div className="finance-kpis"><div><small>{`Doanh Thu Tổng ${financeVenueName}`}</small><strong>{financeTotalRevenue.toLocaleString("vi-VN")} đ</strong></div><div><small>{`Tổng Chi ${financeVenueName} Đã Duyệt`}</small><strong>{financeTotalExpense.toLocaleString("vi-VN")} đ</strong></div><div><small>{`Còn Lại ${financeVenueName}`}</small><strong>{financeRemaining.toLocaleString("vi-VN")} đ</strong></div></div>:<div className="finance-kpis finance-kpis-single"><div><small>{financeMode==="revenue"?`Tổng Doanh Thu ${financeCategoryLabel(financeCategory)} · ${financeVenueName}`:`Tổng Chi ${financeCategoryLabel(financeCategory)} · ${financeVenueName} Đã Duyệt`}</small><strong>{(financeMode==="revenue"?scopedRevenueTotal:scopedExpenseTotal).toLocaleString("vi-VN")} đ</strong></div></div>}
        {financeCategory==="all"?<div className="revenue-category-summary">{[...revenueCategories,["payroll","Lương Nhân Viên"] as const].map(([category,label])=><button key={category} onClick={()=>{setFinanceCategory(category);setModuleSection(sectionForCategory(category));setFinanceMode(category==="payroll"?"expense":"revenue");}}><span>{label}</span><strong>Thu {Number(revenueByCategory[category]||0).toLocaleString("vi-VN")} đ</strong><small>Chi {Number(expenseByCategory[category]||0).toLocaleString("vi-VN")} đ</small></button>)}</div>:financeMode==="revenue"&&<div className="revenue-category-summary scoped-category"><button className="active"><span>Doanh Thu {financeCategoryLabel(financeCategory)}</span><strong>{scopedRevenueTotal.toLocaleString("vi-VN")} đ</strong></button></div>}
        {(financeCategory==="all" || financeCategory==="loto") && <>
        {financeMode==="revenue" && !isGoAnLac && <section className="bonus-summary"><label className="bonus-responsible-picker">Nhân Sự Phụ Trách<select value={bonusResponsibleEmployeeId} onChange={e=>void saveBonusResponsibleEmployee(bonusResponsibleVenueId,e.target.value)}><option value="">Chọn Nhân Sự Loto</option>{employees.filter(employee=>employee.department==="loto").map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><div className="bonus-heading"><div><small>TỔNG KẾT THƯỞNG LOTO · {bonusVenueName}</small><strong>Mục tiêu {bonusWeeklyTarget.toLocaleString("vi-VN")} đ / tuần · Quỹ thưởng tháng 5.000.000 đ · Mỗi tuần không đạt trừ 500.000 đ</strong></div><div><small>Ngày Chốt Kế Tiếp</small><strong>{nextBonusSettlement.toLocaleDateString("vi-VN")}</strong></div>{(profile?.role==="owner"||profile?.role==="manager")&&<button disabled={!canSettleToday} onClick={settleLotoBonuses}>{canSettleToday?"Chốt Và Chi Trả":"Chỉ Chốt Vào Chủ Nhật Đầu Tháng"}</button>}</div><div className="bonus-kpis"><div><span>Tuần Đạt Kế Hoạch</span><b>{achievedBonusWeeks.length}</b></div><div><span>Tuần Không Đạt</span><b>{missedBonusWeeks} × 500.000 đ</b></div>{responsibilityOffEligible&&<div><span>OFF Trong Tháng</span><b>{responsibilityOffDays} ngày · Miễn 2 ngày</b></div>}{responsibilityOffEligible&&<div><span>OFF Vượt Quy Định</span><b>{responsibilityExcessOffDays} × 500.000 đ</b></div>}<div><span>Đã Ứng Thưởng</span><b>{responsibleApprovedAdvance.toLocaleString("vi-VN")} đ</b></div><div><span>Thưởng Còn Lại</span><b>{monthlyResponsibleBonus.toLocaleString("vi-VN")} đ</b></div><div><span>Đã Chi Trả</span><b>{paidBonusTotal.toLocaleString("vi-VN")} đ</b></div></div><div className="bonus-cycle-note">Chu kỳ tháng tính theo tuần bắt đầu vào Thứ Hai. Tháng 08/2026 tính từ 03/08/2026 đến hết 06/09/2026. Tuần không đạt và OFF vượt 2 ngày được trừ độc lập, cộng dồn vào quỹ 5.000.000 đ.</div><div className="bonus-weeks">{periodBonusWeeks.map(week=>{const achieved=Number(week.weekly_revenue||0)>=bonusWeeklyTarget;const completed=week.week_end<=localDateValue();return <article key={week.week_start} className={achieved?"achieved":"not-achieved"}><strong>{new Date(week.week_start+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(week.week_end+"T00:00:00").toLocaleDateString("vi-VN")}</strong><span>{Number(week.weekly_revenue).toLocaleString("vi-VN")} đ / {bonusWeeklyTarget.toLocaleString("vi-VN")} đ</span><b>{!completed?"Chưa Kết Thúc":achieved?(week.settlement_id?"Đã Chốt":"Đạt – Chờ Chốt"):"Không Đạt · Trừ 500.000 đ"}</b></article>})}</div></section>}
        </>}
        {financeMode==="revenue" && (financeCategory==="all"||financeCategory==="loto"||financeCategory==="kiosk") ? <div className="loto-auto-revenue"><strong>{financeCategory==="all"?`Doanh Thu Tổng ${financeVenueName}`:`Doanh Thu ${financeCategory==="loto"?"Loto":"Kios"} · ${financeVenueName} Được Cập Nhật Tự Động`}</strong><span>{financeCategory==="all"?"Tổng Loto + Trò Chơi + Quán Nước + Kios + Thu Khác của đúng sân khấu đang chọn":financeCategory==="loto"?"Tiền Vé Bán − CASE − Bồi Dưỡng − Tặng Phẩm − Kinh Trùng":"Tổng các lần thanh toán Kios đã xác nhận trong ngày"}</span><b>{(financeCategory==="all"?financeTotalRevenue:scopedRevenueTotal).toLocaleString("vi-VN")} đ</b></div> : <div className="finance-form"><label>{financeMode==="revenue"?"Ngày Nhập Thu":"Ngày Nhập Chi"}<select value={financeEntryDate} onChange={e=>setFinanceEntryDate(e.target.value)}>{recentWorkDates().map(date=><option key={date} value={date}>{new Date(date+"T00:00:00").toLocaleDateString("vi-VN")}</option>)}</select></label><label>Hạng Mục<select value={financeCategory} disabled><option value={financeCategory}>{financeCategoryLabel(financeCategory)}</option></select></label><label>Số Tiền<MoneyInput value={financeAmount} onValueChange={setFinanceAmount} /></label><label>Diễn Giải<input value={financeNote} onChange={(e)=>setFinanceNote(e.target.value)} /></label>{editingFinanceId?<div className="finance-edit-actions"><button disabled={saving||!financeAmount} onClick={updateFinanceEntry}>{saving?"Đang Lưu…":"Lưu Chỉnh Sửa"}</button><button className="secondary" onClick={cancelEditingFinance}>Hủy</button></div>:<button disabled={saving||!financeAmount} onClick={saveFinanceEntry}>{financeMode==="revenue"?"Cập Nhật Thu":"Gửi Duyệt Chi"}</button>}</div>}
        <div className="finance-list"><h3>{financeCategory==="all"?"Chi Tiết Toàn Bộ Thu Chi Của Khu":financeMode==="revenue"?`Chi Tiết Thu ${financeCategoryLabel(financeCategory)}`:`Chi Tiết Chi ${financeCategoryLabel(financeCategory)}`}</h3>{financeLoading ? <p className="empty-note">Đang tải dữ liệu…</p> : visibleFinanceEntries.length===0 ? <p className="empty-note">Kỳ này chưa có dữ liệu thuộc phân hệ này.</p> : visibleFinanceEntries.map(item=>{const automatic=item.entry_type==="revenue"&&["loto","game","kiosk"].includes(item.category);return <div className={`finance-row ${editingFinanceId===item.id?"editing":""}`} key={item.id}><span className={item.entry_type}>{item.entry_type==="revenue"?"Thu":"Chi"}</span><strong>{financeCategoryLabel(item.category)}</strong><small>{item.note||""}</small><b>{Number(item.amount).toLocaleString("vi-VN")} đ</b>{automatic?<em>Tự Động</em>:<button onClick={()=>startEditingFinance(item)}>Sửa</button>}</div>})}</div>
      </section> : panel === "ticketInventoryEntry" ?
      <section className="inventory-entry card"><div className="inventory-entry-heading"><div><p className="eyebrow">KHO VÉ THEO SÂN KHẤU</p><h2>Nhập Kho Vé</h2><p>Mỗi sân khấu có kho vé riêng. Mã vé chỉ được nhập vào đúng sân khấu đã chọn và không được trùng với mã đang có trong kho đó.</p></div><label className="inventory-venue-picker"><span>Chọn Sân Khấu Nhập Kho</span><select value={inventoryVenueId} onChange={e=>{const selected=e.target.value;setInventoryVenueId(selected);setMessage("");void loadInventoryStock(selected);}}><option value="">— Chọn Sân Khấu —</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select><small>{inventoryVenueId?`Đang nhập vào kho: ${venues.find(venue=>venue.id===Number(inventoryVenueId))?.name||"Sân Khấu"}`:"Vui lòng chọn đúng sân khấu trước khi nhập mã vé"}</small></label></div>
        <div className="inventory-entry-table"><div className="inventory-entry-head"><span>Mã Vé</span><span>Bàn Giao</span></div>{inventoryEntryRows.map((row,index)=>{const code=row.code.trim();const duplicate=Boolean(code&&(inventoryEntryRows.filter(item=>item.code.trim()===code).length>1||inventoryStockRows.some(item=>String(item.code)===code)));return <div className={`inventory-entry-row ${duplicate?"duplicate-code":""}`} key={row.id} aria-label={duplicate?`Mã vé ${code} bị trùng`:undefined}><input autoFocus={index===0} inputMode="numeric" placeholder="Nhập mã vé" value={row.code} onChange={e=>setInventoryEntryRows(current=>current.map(item=>item.id===row.id?{...item,code:e.target.value.replace(/\D/g,"")}:item))} /><input inputMode="numeric" placeholder="Nhập số lượng" value={row.handover} onChange={e=>setInventoryEntryRows(current=>current.map(item=>item.id===row.id?{...item,handover:e.target.value.replace(/\D/g,"")}:item))} onKeyDown={e=>{if(e.key==="Enter"&&row.code&&row.handover){e.preventDefault();setInventoryEntryRows(current=>[...current,{id:crypto.randomUUID(),code:"",handover:""}]);}}} />{duplicate&&<strong className="duplicate-code-label">Mã vé bị trùng</strong>}</div>})}</div>
        <div className="inventory-entry-actions"><label>Số Dòng Cần Thêm<input type="number" min="1" max="100" defaultValue="5" id="inventory-row-count" /></label><button onClick={()=>{const input=document.getElementById("inventory-row-count") as HTMLInputElement|null;const count=Math.max(1,Math.min(100,Number(input?.value||5)));setInventoryEntryRows(current=>[...current,...Array.from({length:count},()=>({id:crypto.randomUUID(),code:"",handover:""}))]);}}>+ Thêm Dòng</button><button onClick={()=>setInventoryEntryRows(current=>{const used=current.filter(row=>row.code||row.handover);return used.length?used:[{id:crypto.randomUUID(),code:"",handover:""}];})}>Xóa Dòng Trống</button><button className="inventory-save" disabled={inventoryEntrySaving||!inventoryVenueId} onClick={saveTicketInventoryEntry}>{inventoryEntrySaving?"Đang Nhập Kho…":"Cập Nhật Kho Vé"}</button></div>
        <div className="inventory-stock"><div className="inventory-stock-heading"><div className="inventory-stock-title"><span>TỒN KHO HIỆN TẠI</span><div className="inventory-stock-title-row"><h3>{venues.find(venue=>venue.id===Number(inventoryVenueId))?.name||"Chưa Chọn Sân Khấu"}</h3><div className="inventory-stock-meta"><small><b>{inventoryStockRows.length}</b> mã trong kho</small><small><b>{inventoryStockRows.filter(row=>row.status==="active"&&Number(row.handover_quantity)>=5).length}</b> mã khả dụng</small><small>Cập nhật {new Date().toLocaleDateString("vi-VN")}</small></div></div></div><div className="inventory-stock-actions"><button disabled={!inventoryVenueId||inventoryStockLoading} onClick={()=>void loadInventoryStock()}>{inventoryStockLoading?"Đang Tải…":"Làm Mới"}</button><button className="inventory-print" disabled={!inventoryVenueId||inventoryStockLoading||!inventoryStockRows.length} onClick={printInventoryStock}>In / Xuất PDF</button></div></div><form className="inventory-stock-search" onSubmit={event=>{event.preventDefault();setInventorySearchTerm(inventorySearchDraft.trim());setInventoryEditingId(null);}}><label><span>Tìm Mã Vé Trong Kho</span><input inputMode="numeric" placeholder="Ví dụ: 6000" value={inventorySearchDraft} onChange={event=>setInventorySearchDraft(event.target.value.replace(/\D/g,""))} /></label><button type="submit" disabled={!inventoryVenueId}>Tìm Mã Vé</button>{inventorySearchTerm&&<button type="button" className="clear-search" onClick={()=>{setInventorySearchDraft("");setInventorySearchTerm("");setInventoryEditingId(null);}}>Xem Tất Cả</button>}<small>Kết quả chỉ lấy trong đúng kho sân khấu đang chọn.</small></form>{!inventoryVenueId?<p className="empty-note">Chọn sân khấu để xem và đối chiếu tồn kho.</p>:inventoryStockLoading?<p className="empty-note">Đang tải tồn kho…</p>:inventoryStockRows.length===0?<p className="empty-note">Kho sân khấu này chưa có mã vé.</p>:<div className="inventory-stock-table"><div className="inventory-stock-head"><span>Mã Vé</span><span>Bàn Giao / Tồn</span><span>Trạng Thái</span></div>{[...inventoryStockRows].filter(row=>!inventorySearchTerm||String(row.code).includes(inventorySearchTerm)).sort((a,b)=>{const exactA=String(a.code)===inventorySearchTerm?0:1;const exactB=String(b.code)===inventorySearchTerm?0:1;const lowA=Number(a.handover_quantity)<5?0:1;const lowB=Number(b.handover_quantity)<5?0:1;return exactA-exactB||lowA-lowB||String(a.code).localeCompare(String(b.code),"vi",{numeric:true});}).map(row=><div className={`inventory-stock-row ${Number(row.handover_quantity)<5?"low-stock":""} ${inventoryEditingId===row.id?"is-editing":""}`} key={row.id}><strong>{row.code}</strong>{inventoryEditingId===row.id?<input className="inventory-actual-input" autoFocus inputMode="numeric" aria-label={`Tồn thực tế mã ${row.code}`} value={inventoryEditQuantity} onChange={event=>setInventoryEditQuantity(event.target.value.replace(/\D/g,""))} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();void updateTicketInventoryActual();}}}/>:<b>{Number(row.handover_quantity).toLocaleString("vi-VN")}</b>}<span>{row.status!=="active"?"Đã Ngừng Sử Dụng":Number(row.handover_quantity)<5?"Sẽ Hủy Tự Động":"Đang Sử Dụng"}</span><div className="inventory-row-actions">{inventoryEditingId===row.id?<><button type="button" className="save-actual" disabled={inventoryUpdating} onClick={()=>void updateTicketInventoryActual()}>{inventoryUpdating?"Đang Lưu…":"Lưu Tồn Thực Tế"}</button><button type="button" disabled={inventoryUpdating} onClick={()=>{setInventoryEditingId(null);setInventoryEditQuantity("");}}>Hủy</button></>:<button type="button" onClick={()=>{setInventoryEditingId(row.id);setInventoryEditQuantity(String(Number(row.handover_quantity)));}}>Sửa Tồn</button>}</div></div>)}</div>}</div>
      </section> : panel === "ticketReport" ?
      <section className="ticket-report card">
        <div className="report-heading"><div><p className="eyebrow">ĐỐI CHIẾU VÉ THEO PHIÊN</p><h2>{reportHistoryMode?"Lịch Sử Báo Cáo Vé":"Báo Cáo Vé"}</h2><small className="report-formula">Thiếu / Thừa = Tồn Hệ Thống − (Tồn Thực Tế + Vé Lỗi)</small></div><div className="report-filters"><div className="report-history-switch"><button className={!reportHistoryMode?"active":""} onClick={()=>{setReportHistoryMode(false);void loadPendingTicketReportShifts(reportVenueId,true,reportVarianceOnly,false,reportHistoryDate);}}>Chờ Báo Cáo</button><button className={reportHistoryMode?"active":""} onClick={()=>{setReportHistoryMode(true);void loadPendingTicketReportShifts(reportVenueId,true,false,true,reportHistoryDate);}}>Xem Lịch Sử</button></div><label className="report-venue">Sân Khấu<select value={reportVenueId} onChange={(e)=>{const selected=e.target.value;setReportVenueId(selected);setReportShiftId("");setReportRounds([]);void loadPendingTicketReportShifts(selected,true,reportVarianceOnly,reportHistoryMode,reportHistoryDate);}}>{profile?.role==="owner"&&<option value="all">Tất Cả Sân Khấu</option>}<option value="">— Chọn Sân Khấu —</option>{venues.map(venue=><option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></label>{reportHistoryMode&&<label className="report-history-date">Ngày Báo Cáo<input type="date" value={reportHistoryDate} onChange={e=>{setReportHistoryDate(e.target.value);void loadPendingTicketReportShifts(reportVenueId,true,false,true,e.target.value);}} /></label>}<button onClick={() => loadPendingTicketReportShifts(reportVenueId,true,reportVarianceOnly,reportHistoryMode,reportHistoryDate)}>Làm Mới</button></div></div>
        <div className="report-pending-section"><div className="report-pending-title"><div><span>{reportHistoryMode?"Số Phiên Trong Ngày":showTicketVarianceOnly?"Số Phiên Có Sai Lệch":"Số Phiên Chưa Báo Cáo"}</span><strong>{pendingReportShifts.length}</strong></div><small>{reportHistoryMode?"Chọn phiên để xem lại báo cáo đã lưu; vòng hoàn tất được khóa chỉnh sửa.":showTicketVarianceOnly?"Chỉ liệt kê phiên đã hoàn tất Báo Cáo Vé và còn sai lệch thực tế.":"Chọn đúng phiên để tiếp tục hoặc bắt đầu đối chiếu."}</small></div><div className="report-pending-list">{pendingReportShifts.length===0?<p className="empty-note">{reportHistoryMode?"Không có Báo Cáo Vé trong ngày đã chọn.":showTicketVarianceOnly?"Sân khấu này không có phiên Báo Cáo Vé nào đang sai lệch.":"Sân khấu này không có phiên nào đang chờ Báo Cáo Vé."}</p>:pendingReportShifts.map(shift=><button key={shift.id} className={String(shift.id)===reportShiftId?"active":""} onClick={()=>{setReportShiftId(String(shift.id));void loadTicketReport(String(shift.id));}}><b>{shift.name}</b><span>{shift.performance_date?new Date(shift.performance_date+"T00:00:00").toLocaleDateString("vi-VN"):"Chưa Có Ngày"}</span><em>{shift.report_started?"Đang Báo Cáo":"Chưa Báo Cáo"} · {shift.verified_count}/{shift.round_count} vòng hoàn tất</em></button>)}</div></div>
        <div className="report-scope"><span>Đang báo cáo sân khấu</span><strong>{venues.find(venue=>String(venue.id)===reportVenueId)?.name||"Chưa Chọn Sân Khấu"}</strong><small>{reportShiftId?`Phiên ${pendingReportShifts.find(shift=>String(shift.id)===reportShiftId)?.name||reportShiftId}`:"Chưa chọn phiên cần báo cáo."}</small></div>
        {showTicketVarianceOnly&&<div className="report-scope"><span>Chỉ Hiển Thị Vòng Sai Lệch</span><b>Vòng chưa hoàn tất Báo Cáo Vé và mã đã duyệt hủy không được tính vào dư/thiếu.</b></div>}
        <div className="report-kpis"><div><small>Số Vòng</small><strong>{kpiReportRounds.length}</strong></div><div><small>Tổng Vé Bán</small><strong>{kpiReportRounds.reduce((sum,row)=>sum+Number(row.sold_quantity),0)}</strong></div><div><small>Vòng Khớp</small><strong>{validReportedRounds.filter(row=>ticketRoundReconciliation(row).variance===0).length}</strong></div><div><small>Vòng Lệch / Thiếu</small><strong>{mismatchedReportRounds.length}</strong></div></div>
        <div className="report-list">{reportLoading ? <p className="empty-note">Đang tải dữ liệu…</p> : visibleReportRounds.length===0 ? <p className="empty-note">{showTicketVarianceOnly?"Không có vòng sai lệch thực tế. Vòng chưa hoàn tất báo cáo và mã đã duyệt hủy đã được loại khỏi đối chiếu.":"Ngày này chưa có vòng vé nào đã bán."}</p> : visibleReportRounds.map(round => { const reconciliation=ticketRoundReconciliation(round); const {expected,reported,variance}=reconciliation; const entered=reconciliation.hasCompleteEntry; const visibleCodes=round.ticket_round_codes; const varianceAmount=variance*Number(round.ticket_price); const result=reconciliation.activeCodes.length===0 ? "Đã Hủy Toàn Bộ Mã" : !entered ? "Chưa Đối Chiếu" : variance===0 ? "Khớp" : variance>0 ? `Thiếu ${variance} Vé` : `Thừa ${Math.abs(variance)} Vé`; const verified=round.status==="verified"; return <article className={`report-round ${entered ? variance===0 ? "matched" : "mismatched" : ""}`} key={round.id}><div className="round-summary"><strong>Vòng {round.sequence_no}{promotionMetaFromClientId(round.client_id||"").promotionRole&&<em className={`report-promotion-badge ${promotionMetaFromClientId(round.client_id||"").promotionRole}`}>{promotionMetaFromClientId(round.client_id||"").promotionRole==="sale"?"VÉ BÁN":"VÉ TẶNG"}</em>}</strong><span className="round-price">{promotionMetaFromClientId(round.client_id||"").promotionRole==="gift"?<>Không Tính Doanh Thu</>:<>Vòng Giá <b>{Number(round.ticket_price).toLocaleString("vi-VN")} đ</b></>}</span><span>Đã Bán <b>{round.sold_quantity}</b></span><span>Tồn Hệ Thống <b>{expected}</b></span><span>Tồn Thực Tế + Vé Lỗi <b>{entered ? reported : "—"}</b></span><span>Kết Quả <b className={entered ? variance===0 ? "result-ok" : "result-error" : ""}>{result}</b></span><span>Sai Số Tiền <b className={entered && variance!==0 ? "result-error" : ""}>{entered ? `${Math.abs(varianceAmount).toLocaleString("vi-VN")} đ` : "—"}</b></span></div><div className="report-codes">{[...visibleCodes].sort((a,b)=>a.slot-b.slot).map(code => { const belowMinimum=code.actual_remaining!==null && Number(code.actual_remaining)<5; return <div className="report-code" key={code.slot}><strong>Mã Vé {code.ticket_inventory?.code||"—"}</strong><label>Vé Tồn Thực Tế<input type="number" min="0" disabled={verified} value={code.actual_remaining??""} onChange={(e)=>updateReportCode(round.id,code.slot,"actual_remaining",e.target.value)} /></label>{expandedDefectiveCodes[`${round.id}-${code.slot}`] ? <label className="defective-field">Vé Lỗi<div className="defective-controls"><input autoFocus type="number" min="0" disabled={verified} value={code.defective_quantity||""} onChange={(e)=>updateReportCode(round.id,code.slot,"defective_quantity",e.target.value)} />{!verified&&Number(code.defective_quantity||0)===0&&<button type="button" aria-label="Đóng ô vé lỗi" onClick={()=>setExpandedDefectiveCodes(current=>({...current,[`${round.id}-${code.slot}`]:false}))}>×</button>}</div></label> : <button type="button" className="defective-toggle" disabled={verified} onClick={()=>setExpandedDefectiveCodes(current=>({...current,[`${round.id}-${code.slot}`]:true}))}>+ Vé Lỗi</button>}{code.cancellation_status==="approved" ? <span className="cancelled-badge">Đã Hủy Tự Động</span> : belowMinimum ? <span className="cancelled-badge">{verified?"Đã Hủy Tự Động":"Sẽ Hủy Tự Động Khi Hoàn Tất"}</span> : <span className="kept-badge">Đang Sử Dụng</span>}</div>})}</div><div className={"report-finalize "+(reconciliation.hasOutstandingVariance&&profile?.role==="owner"?"variance-confirm-visible":"")}>{verified ? reconciliation.hasOutstandingVariance&&profile?.role==="owner" ? <div className="variance-confirm-actions"><strong>Vé lỗi / thiếu / dư đang chờ chủ sở hữu xác nhận</strong><small>Kho sẽ lấy Tồn Thực Tế; Vé Lỗi không cộng vào tồn khả dụng.</small><button disabled={confirmingVarianceRoundId===round.id} onClick={()=>void confirmTicketVariance(round.id)}>{confirmingVarianceRoundId===round.id?"Đang Xác Nhận…":"Xác Nhận Báo Cáo & Cập Nhật Kho"}</button></div> : reconciliation.isVarianceConfirmed ? <strong className="variance-confirmed">Đã Được Chủ Sở Hữu Xác Nhận – Kho Đã Cập Nhật</strong> : <strong>Đã Hoàn Tất – Tồn Đã Khóa</strong> : <button disabled={!entered} onClick={()=>finalizeTicketReport(round.id)}>Hoàn Tất Báo Cáo Vòng</button>}</div></article>})}</div>
        {!showTicketVarianceOnly&&reportableReportRounds.length>0&&<div className="report-finalize-all"><div><strong>Hoàn Tất Báo Cáo Vé</strong><small>Một lần duy nhất sau khi đã nhập đủ Tồn Thực Tế cho toàn bộ vòng.</small></div>{reportableReportRounds.every(round=>round.status==="verified")?<b>Đã Hoàn Tất Toàn Bộ</b>:<button disabled={saving||reportableReportRounds.some(round=>!ticketRoundReconciliation(round).hasCompleteEntry)} onClick={()=>void finalizeAllTicketReports()}>{saving?"Đang Hoàn Tất…":"Hoàn Tất Toàn Bộ Báo Cáo"}</button>}</div>}
      </section> : activeShift && panel === "tickets" ?
      <section className="ticket-workspace card">


        <div className="ticket-fixed-control-block" ref={ticketFixedControlRef}>
        {!historyMode&&shiftTicketStockAlert&&(!shiftTicketStockAlert.source_configured||shiftTicketStockAlert.available_codes<=150||shiftTicketStockAlert.stale_codes.length>0)&&<section className="shift-ticket-stock-alert" role="alert">
          <strong>CẢNH BÁO KHO VÉ · {venues.find(venue=>venue.id===shiftTicketStockAlert.venue_id)?.name||"Sân Khấu"}</strong>
          {!shiftTicketStockAlert.source_configured?<b>CHƯA CẤU HÌNH NGUỒN</b>:<>
            {shiftTicketStockAlert.available_codes<=150&&<b>Chỉ còn {shiftTicketStockAlert.available_codes} mã vé khả dụng.</b>}
            {shiftTicketStockAlert.stale_codes.length>0&&<details><summary>{shiftTicketStockAlert.stale_codes.length} mã chưa sử dụng từ 10 ngày — bấm để xem</summary><div>{shiftTicketStockAlert.stale_codes.map(code=><p key={code.code}><strong>Mã {code.code}</strong><span>Tồn {code.quantity} vé</span><b>{code.days_unused} ngày</b></p>)}</div></details>}
          </>}
        </section>}
        {message&&!historyMode&&<div role={isTransientNotice(message)?"status":"alert"} className={`error banner-error ticket-block-message ${isTransientNotice(message)?"ticket-toast-success":""}`}>{message}</div>}
        {ticketOwnedByAnother&&profile?.role!=="owner"&&<div className="ticket-lock-notice"><strong>FILE ĐANG ĐƯỢC KHÓA</strong><span>File đang do tài khoản <b>{ticketLockOwnerName}</b> phụ trách. Bạn chỉ được xem. Muốn tiếp quản, tài khoản đang làm phải đóng ca; sau đó bạn mở lại đúng ca vừa đóng.</span></div>}
        {ticketReadOnly&&<div className="ticket-shift-context-overlay"><div className="ticket-shift-context"><strong className="history-badge">{ticketReadOnlyLabel}</strong>{activeShift.status==="closed"&&["owner","manager"].includes(profile?.role||"")&&<button disabled={saving} className="reopen-shift-button" onClick={reopenCurrentShift}>{saving?"Đang Mở…":"Mở Lại Ca Vừa Đóng"}</button>}</div></div>}
        <div className="ticket-toolbar"><div className="ticket-title-center"><div className="case-buttons"><button disabled={ticketReadOnly} className={caseMode === "holiday" ? "active" : ""} onClick={() => setCaseMode("holiday")}>Lễ</button><button disabled={ticketReadOnly} className={caseMode === "tet" ? "active" : ""} onClick={() => setCaseMode("tet")}>Tết</button><button disabled={ticketReadOnly} className={caseMode === "half" ? "active" : ""} onClick={() => setCaseMode("half")}>50%</button><button disabled={ticketReadOnly} className={caseMode === "regular" || caseMode === "weekend" ? "active" : ""} onClick={() => setCaseMode("regular")}>100%</button><button disabled={ticketReadOnly} className={caseMode === "support100" ? "active" : ""} onClick={() => setCaseMode("support100")}>100.000</button><button disabled={ticketReadOnly} className={caseMode === "support200" ? "active" : ""} onClick={() => setCaseMode("support200")}>200.000</button></div></div><div className="ticket-tools"><strong>{ticketLoading ? "Đang Tải Dữ Liệu…" : "Đã Kết Nối Dữ Liệu"}</strong><label>Thu Phóng<select value={ticketZoom} onChange={(e) => setTicketZoom(e.target.value)}><option value="0.75">75%</option><option value="0.9">90%</option><option value="1">100%</option></select></label><button onClick={() => setPanel("overview")}>Quay Lại</button><span className="ticket-shift-actions">{!ticketReadOnly&&<button type="button" className="shift-staff-visible-button" onClick={()=>{setSelectedStaff(shiftStaff.map(person=>person.id));setEditingShiftStaff(current=>!current);}}>{editingShiftStaff?"Đóng Chọn Nhân Sự":"Thêm / Xóa"}</button>}{activeShift.status==="open"&&(!ticketReadOnly||profile?.role==="owner")&&<button className="close-shift-button" onClick={closeCurrentShift}>Đóng Ca</button>}</span></div></div>
        {editingShiftStaff&&<div className="shift-staff-editor shift-staff-picker"><details open><summary><span>Danh Sách Nhân Sự Loto <small>Không giới hạn số người</small></span><b>{selectedStaff.length} người đã chọn</b></summary><div className="staff-list">{ticketStaffOptions.map(employee=><label className={`staff-item ${selectedStaff.includes(employee.id)?"selected":""}`} key={employee.id}><input type="checkbox" checked={selectedStaff.includes(employee.id)} onChange={()=>toggleStaff(employee.id)} />{employee.full_name}</label>)}</div></details><div className="shift-staff-picker-actions"><small>Tích để thêm, bỏ tích để xóa nhân sự khỏi phiên làm việc. Có thể chọn 10–20 người hoặc nhiều hơn.</small><button disabled={saving||selectedStaff.length<1} onClick={updateShiftStaff}>{saving?"Đang Cập Nhật…":"Xác Nhận"}</button><button className="secondary" onClick={()=>{setSelectedStaff(shiftStaff.map(person=>person.id));setEditingShiftStaff(false);}}>Hủy</button></div></div>}
        <div className="ticket-column-header-sticky"><table className="work-table" style={ticketTableFitStyle}><thead><tr><th>Ngày</th>{Array.from({length:ticketCodeColumnCount},(_,index)=><th className="ticket-code-head" key={index+1}>Mã Vé {index+1}</th>)}{ticketCodeColumnCount<3&&<th className="ticket-add-code-head"><button type="button" disabled={ticketReadOnly} onClick={()=>setVisibleTicketCodeColumns(current=>Math.min(3,current+1))}>+ Thêm Mã</button></th>}{shiftStaff.map((person,index) => <th className={`staff-head ${index===0?"staff-group-start":""}`} key={person.id}>{person.full_name}</th>)}<th>Giá Vé</th><th>Tặng Phẩm</th><th>Thành Tiền</th><th>Tồn Đầu</th><th>Tổng Vé</th></tr></thead></table></div>
        </div>
        <div className={`ticket-table-wrap ${ticketReadOnly ? "ticket-history-readonly" : ""}`}><table className="work-table" style={ticketTableFitStyle}><thead className="ticket-source-head"><tr><th>Ngày</th>{Array.from({length:ticketCodeColumnCount},(_,index)=><th className="ticket-code-head" key={index+1}>Mã Vé {index+1}</th>)}{ticketCodeColumnCount<3&&<th className="ticket-add-code-head"><button type="button" disabled={ticketReadOnly} onClick={()=>setVisibleTicketCodeColumns(current=>Math.min(3,current+1))}>+ Thêm Mã</button></th>}{shiftStaff.map((person,index) => <th className={`staff-head ${index===0?"staff-group-start":""}`} key={person.id}>{person.full_name}</th>)}<th>Giá Vé</th><th>Tặng Phẩm</th><th>Thành Tiền</th><th>Tồn Đầu</th><th>Tổng Vé</th></tr></thead><tbody>{ticketRows.map((row,rowIndex) => { const total=ticketTotals(row); const completed=Object.values(row.quantities).some(value => value !== ""); return <tr className={`${completed ? "completed-row" : ""} ${row.rowColor ? `ticket-row-mark-${row.rowColor}` : ""} ${row.promotionRole ? `promotion-${row.promotionRole}-row` : ""}`} key={row.id}><td className="date-value">{row.promotionRole&&<span className="promotion-row-badge">{row.promotionRole==="sale"?"VÉ BÁN":"VÉ TẶNG"}</span>}{activeShift.performance_date?new Date(activeShift.performance_date+"T00:00:00").toLocaleDateString("vi-VN"):"Chưa Chọn"}{!ticketReadOnly&&<select className={`ticket-row-color-picker ${row.rowColor?`is-${row.rowColor}`:""}`} aria-label={`Tô màu dòng ${rowIndex+1}`} title="Đánh dấu màu cho dòng" value={row.rowColor||""} onChange={e=>updateTicketRow(rowIndex,current=>({...current,rowColor:(e.target.value||undefined) as TicketRow["rowColor"]}))}><option value="">⬜</option><option value="green">🟩</option><option value="red">🟥</option><option value="yellow">🟨</option><option value="pink">🩷</option><option value="purple">🟪</option></select>}</td>{row.codes.slice(0,ticketCodeColumnCount).map((code,slot) => <td className="ticket-code-cell" key={slot}><div className="ticket-code-entry"><input disabled={ticketReadOnly} tabIndex={ticketReadOnly ? -1 : 0} inputMode="numeric" autoComplete="off" className={`ticket-code-input ${ticketCodeIssue(code)?"invalid":""}`} value={code} onChange={(e)=>inputTicketCode(rowIndex,slot,e.target.value)} onBlur={()=>validateTicketCode(rowIndex,slot,code)} />{ticketCodeIssue(code)&&<small>{ticketCodeIssueLabel(code)}</small>}</div></td>)}{ticketCodeColumnCount<3&&<td className="ticket-add-code-cell" aria-hidden="true"></td>}{shiftStaff.map((person,index) => <td className={`staff-quantity-cell ${index===0?"staff-group-start":""}`} key={person.id}><input disabled={ticketReadOnly||row.promotionRole==="gift"} tabIndex={ticketReadOnly||row.promotionRole==="gift" ? -1 : 0} type="number" min="0" value={row.quantities[person.id] || ""} onChange={(e) => updateTicketQuantity(rowIndex,person.id,e.target.value)} />{row.quantities[person.id] !== undefined && row.quantities[person.id] !== "" && <small className="staff-sale-amount">{(Number(row.quantities[person.id] || 0) * row.price).toLocaleString("vi-VN")} đ</small>}</td>)}<td><select disabled={ticketReadOnly||row.promotionRole==="gift"} tabIndex={ticketReadOnly||row.promotionRole==="gift" ? -1 : 0} className="ticket-strong-select" value={row.price} onChange={(e) => updateTicketRow(rowIndex,current => ({...current,price:Number(e.target.value)}))}>{[10000,20000,30000,40000,50000,70000,100000].map(price => <option key={price} value={price}>{price.toLocaleString("vi-VN")}</option>)}</select></td><td><select disabled={ticketReadOnly||row.promotionRole==="gift"} tabIndex={ticketReadOnly||row.promotionRole==="gift" ? -1 : 0} className="ticket-strong-select" value={row.gift} onChange={(e) => updateTicketRow(rowIndex,current => ({...current,gift:e.target.value}))}><option value=""></option>{giftOptions.map(gift => <option key={gift} value={gift}>{gift.toLocaleString("vi-VN")}</option>)}</select></td><td className="money-value">{row.promotionRole==="gift" ? "0 đ" : Object.values(row.quantities).some(Boolean) ? `${total.amount.toLocaleString("vi-VN")} đ` : ""}</td><td className="calculated">{row.codes.some(Boolean) ? total.opening : ""}</td><td className="calculated">{Object.values(row.quantities).some(Boolean) ? total.sold : ""}</td></tr>})}</tbody></table></div>
        <div className="work-summary"><div className="salary-grid" style={{ gridTemplateColumns: `145px repeat(${Math.max(shiftStaff.length, 1)}, minmax(135px, 1fr))` }}><div className="summary-label">CASE</div>{shiftStaff.map(person => <div className="salary-cell" key={person.id}><strong>{person.full_name}</strong><span>{employeeCase(person).toLocaleString("vi-VN")} đ</span></div>)}<div className="summary-label">Bồi Dưỡng</div>{shiftStaff.map(person => <div className="allowance-cell" key={person.id}><MoneyInput disabled={ticketReadOnly} placeholder="Nhập Tiền" value={allowances[person.id]||""} onValueChange={value=>setAllowances(current=>({...current,[person.id]:value}))} /></div>)}<div className="ticket-compact-summary-row" style={{gridColumn:"1 / -1"}}><label className="ticket-compact-field"><span>Kinh Trùng</span><MoneyInput disabled={ticketReadOnly} placeholder="Nhập tổng tiền" value={kinhTrung} onValueChange={setKinhTrung} /></label><label className="ticket-compact-field"><span>Organ</span><select disabled={ticketReadOnly} value={ticketExtraRoles.organ} onChange={event=>updateTicketExtraRole("organ",event.target.value)}><option value="">Chọn nhân sự</option>{ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select><b>{organCasePerson?employeeCaseValue(organCasePerson).toLocaleString("vi-VN"):"0"} đ</b></label><label className="ticket-compact-field"><span>Soát Vé</span><select disabled={ticketReadOnly} value={ticketExtraRoles.ticketChecker} onChange={event=>updateTicketExtraRole("ticketChecker",event.target.value)}><option value="">Chọn nhân sự</option>{ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select><b>{ticketCheckerCasePerson?employeeCaseValue(ticketCheckerCasePerson).toLocaleString("vi-VN"):"0"} đ</b></label></div></div><div className="summary-kpis"><div><span>Tổng Doanh Thu</span><strong>{netRevenue.toLocaleString("vi-VN")} đ</strong></div><div><span>Tổng Tặng Phẩm</span><strong>{summary.gifts.toLocaleString("vi-VN")} đ</strong></div><div><span>Tổng Case</span><strong>{totalCase.toLocaleString("vi-VN")} đ</strong></div></div></div>
        {!ticketReadOnly&&<div className="ticket-actions"><label className="add-rows-control"><span>Số Dòng Cần Thêm</span><input type="number" min="1" max="100" value={rowsToAdd} onChange={(e)=>setRowsToAdd(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter") addTicketRows();}} /></label><button onClick={addTicketRows}>+ Thêm Dòng</button><button className="promotion-add-button" disabled={ticketRows.some(row=>Boolean(row.promotionGroupId))} onClick={addBuyOneGiftOneRound}>+ Thêm Vòng Mua 1 Tặng 1</button><button onClick={() => setTicketRows(current => { const used=current.filter(row => row.codes.some(Boolean)||Object.values(row.quantities).some(Boolean)||row.gift); return used.length ? used : [blankTicketRow()]; })}>Xóa Dòng Trống</button></div>}
      </section> : activeShift ?
      <section className="card overview-card overview-command-center">
        {overviewTicketVariancePanel}
        {profile?.role==="owner"&&<div className="overview-approval-bar"><button className={`overview-approval-button ${approvalCount>0?"has-pending":"all-clear"}`} onClick={()=>{setPanel("approvals");void loadApprovals();}}><span>{approvalCount>0?"Cần Duyệt":"Đã Duyệt Hết"}</span><strong>{approvalCount>0?`${approvalCount} Yêu Cầu Đang Chờ`:"Không Còn Yêu Cầu Chờ Xử Lý"}</strong><em>{approvalCount>0?"Yêu cầu cũ nhất được xếp trước →":"Xem toàn bộ lịch sử đã duyệt →"}</em></button></div>}
        <div className="overview-venue-revenue-buttons"><button className={overviewRevenueSelection==="company"?"active":""} aria-pressed={overviewRevenueSelection==="company"} onClick={()=>openRevenueVenue(null)}>Doanh Thu Công Ty</button>{["Đức Hòa","Go An Lạc","Liên Minh","Lộc Ninh"].map(name=>{const venue=venues.find(v=>v.name.toLowerCase().includes(name.toLowerCase()));const selected=!!venue&&overviewRevenueSelection===String(venue.id);return <button className={selected?"active":""} aria-pressed={selected} key={name} disabled={!venue} onClick={()=>venue&&openRevenueVenue(venue.id)}>Doanh Thu {name}</button>})}</div><div className="overview-revenue-dashboard"><div className="overview-revenue-heading"><div><p className="eyebrow">THỐNG KÊ THEO NGÀY LÀM VIỆC</p><h3>Thống Kê Doanh Thu</h3><small>{overviewRevenue?new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN"):"Đang Cập Nhật"}</small></div><div className="overview-revenue-controls"><label><span>Ngày Xem Doanh Thu</span><select value={overviewRevenueDate} onChange={event=>changeOverviewRevenueDate(event.target.value)}>{revenueHistoryDates().map(date=><option key={date} value={date}>{new Date(date+"T12:00:00").toLocaleDateString("vi-VN")}{date===localDateValue()?" · Hôm Nay":""}</option>)}</select></label><button onClick={()=>void loadOverviewRevenue(activeShift,overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):null,overviewRevenueDate)} disabled={overviewRevenueLoading}>{overviewRevenueLoading?"Đang Tải…":"Làm Mới"}</button></div></div>
          <div className="overview-revenue-kpis"><article className="overview-total-card"><span>Doanh Thu Hôm Nay</span><strong>{(overviewRevenue?.current.total||0).toLocaleString("vi-VN")} đ</strong><small>Tổng Tất Cả Nguồn Thu {overviewRevenueSelection==="company"?"Của Công Ty":"Của Sân Khấu"}</small></article><article className="overview-week-card"><span>Doanh Thu Trong Tuần</span><strong>{(overviewRevenue?.currentWeek.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?`${new Date(overviewRevenue.weekStart+"T12:00:00").toLocaleDateString("vi-VN")} – ${new Date(overviewRevenue.weekEnd+"T12:00:00").toLocaleDateString("vi-VN")}`:"Thứ Hai đến phiên cuối Chủ Nhật"}</small></article><article className="overview-month-card"><span>Doanh Thu Trong Tháng</span><strong>{(overviewRevenue?.currentMonth.total||0).toLocaleString("vi-VN")} đ</strong><small>{overviewRevenue?`${new Date(overviewRevenue.monthStart+"T12:00:00").toLocaleDateString("vi-VN")} – ${new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN")}`:"Từ đầu tháng đến phiên đang xem"}</small></article>{[
            {label:"So Với Hôm Qua",date:overviewRevenue?.yesterdayDate,total:overviewRevenue?.yesterday.total||0,result:yesterdayComparison},
            {label:"So Với Tuần Trước",date:overviewRevenue?.previousWeekDate,total:overviewRevenue?.previousWeek.total||0,result:previousWeekComparison},
          ].map(item=><article className={`overview-comparison ${item.result.difference>0?"up":item.result.difference<0?"down":"same"}`} key={item.label}><span>{item.label}</span><strong>{item.result.difference>0?"+":""}{item.result.difference.toLocaleString("vi-VN")} đ</strong><b>{item.result.percent===null?(item.total===0?"Chưa Có Dữ Liệu Đối Chiếu":"—"):`${item.result.percent>0?"+":""}${item.result.percent.toLocaleString("vi-VN",{maximumFractionDigits:1})}%`}</b><small>{item.date?new Date(item.date+"T12:00:00").toLocaleDateString("vi-VN"):"—"} · {item.total.toLocaleString("vi-VN")} đ</small></article>)}</div>
          <div className="overview-category-grid">{Object.entries(overviewCategoryLabels).map(([category,label])=><article key={category}><span>{label}</span><strong>{Number(overviewRevenue?.current.categories[category]||0).toLocaleString("vi-VN")} đ</strong></article>)}</div>
          {overviewCompanyFinanceSummary}
          {overviewStageFinanceSummary}
        </div>
        {overviewRevenueSelection&&<section className="overview-revenue-detail card"><div className="overview-revenue-detail-heading"><div><p className="eyebrow">BÁO CÁO THEO SÂN KHẤU</p><h3>{overviewRevenueSelection==="company"?"Doanh Thu Công Ty":`Chi Tiết Doanh Thu ${venues.find(v=>String(v.id)===overviewRevenueSelection)?.name||"Sân Khấu"}`}</h3><small>Doanh thu và báo cáo chỉ lấy dữ liệu đúng phạm vi đã chọn.</small></div><button onClick={()=>{setOverviewRevenueSelection(null);setFinanceVenueOverride(null);}}>← Quay Lại</button></div>{overviewRevenueSelection==="company"?<div className="overview-company-venues">{venues.map(venue=>{const row=overviewVenueRevenue.find(item=>item.venue_id===venue.id);return <article key={venue.id}><strong>{venue.name}</strong><span>Hôm Nay <b>{Number(row?.day_total||0).toLocaleString("vi-VN")} đ</b></span><span>Trong Tuần <b>{Number(row?.week_total||0).toLocaleString("vi-VN")} đ</b></span></article>})}</div>:<><div className="overview-revenue-detail-grid">{Object.entries(overviewCategoryLabels).map(([category,label])=><article key={category}><span>{label}</span><strong>{Number(overviewRevenue?.current.categories[category]||0).toLocaleString("vi-VN")} đ</strong></article>)}</div>{!overviewBonusVenueKey.includes("go an lac")&&<><div className="overview-bonus-inline"><label className="overview-bonus-person"><span>Nhân Sự Phụ Trách</span><select value={bonusResponsibleEmployeeId} onChange={event=>void saveBonusResponsibleEmployee(bonusResponsibleVenueId,event.target.value)}><option value="">Chọn Nhân Sự Loto</option>{ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id}>{employee.full_name}</option>)}</select></label><div><span>Quỹ Thưởng Tháng</span><strong>5.000.000 đ</strong></div><div><span>Mục Tiêu Theo Sân Khấu</span><strong>{overviewBonusTarget.toLocaleString("vi-VN")} đ / Tuần</strong></div><div><span>Tuần Đạt Kế Hoạch</span><strong>{achievedBonusWeeks.length}</strong></div><div><span>Tuần Không Đạt</span><strong>{missedBonusWeeks} × 500.000 đ</strong></div><div><span>Đã Ứng Thưởng</span><strong>{responsibleApprovedAdvance.toLocaleString("vi-VN")} đ</strong></div><div><span>Thưởng Còn Lại</span><strong>{monthlyResponsibleBonus.toLocaleString("vi-VN")} đ</strong></div></div><div className="bonus-cycle-note">Chu kỳ tháng tính theo tuần bắt đầu vào Thứ Hai. Ví dụ tháng 08/2026 tính từ 03/08/2026 đến hết 06/09/2026.</div><div className="bonus-weeks overview-bonus-weeks">{periodBonusWeeks.length===0?<p>Chưa có tuần thưởng trong tháng này.</p>:periodBonusWeeks.map(week=>{const achieved=Number(week.weekly_revenue||0)>=overviewBonusTarget;return <article key={week.week_start} className={achieved?"achieved":"not-achieved"}><strong>{new Date(week.week_start+"T00:00:00").toLocaleDateString("vi-VN")} – {new Date(week.week_end+"T00:00:00").toLocaleDateString("vi-VN")}</strong><span>{Number(week.weekly_revenue).toLocaleString("vi-VN")} đ / {overviewBonusTarget.toLocaleString("vi-VN")} đ</span><b>{week.week_end>localDateValue()?"Chưa Kết Thúc":achieved?"Đạt":"Không Đạt · Trừ 500.000 đ"}</b></article>})}</div></>}</>}</section>}
        {overviewRevenueSelection!=="company"&&overviewBonusVenueKey.includes("go an lac")&&<section className="bonus-summary go-an-lac-bonus"><div className="bonus-heading"><div><strong>3 Nhân Sự Phụ Trách · Đêm {overviewRevenue?.date?new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN"):"diễn"}</strong><small>Doanh thu Loto trên 10.000.000 đ được thưởng tổng 12% · mỗi nhân sự 4%. Khoản thưởng được cộng riêng vào tổng thưởng cuối năm.</small></div><div><small>Doanh Thu Loto Phiên</small><strong>{goAnLacShiftLotoRevenue.toLocaleString("vi-VN")} đ</strong></div></div><div className="go-an-lac-responsibles">{[0,1,2].map(index=><label key={index}>Nhân sự {index+1}<select value={goAnLacResponsibleIds[index]} onChange={event=>setGoAnLacResponsibleIds(current=>current.map((id,position)=>position===index?event.target.value:id))}><option value="">Chọn nhân sự</option>{ticketStaffOptions.map(employee=><option key={employee.id} value={employee.id} disabled={goAnLacResponsibleIds.some((id,position)=>position!==index&&id===String(employee.id))}>{employee.full_name}</option>)}</select></label>)}</div><div className="bonus-kpis"><div><span>Điều Kiện</span><b>{goAnLacShiftLotoRevenue>10000000?"Đạt":"Chưa Đạt"}</b></div><div><span>Tổng Tỷ Lệ Thưởng</span><b>12%</b></div><div><span>Mỗi Nhân Sự</span><b>{goAnLacShiftLotoRevenue>10000000?Math.round(goAnLacShiftLotoRevenue*0.04).toLocaleString("vi-VN"):"0"} đ · 4%</b></div><button disabled={goAnLacRewardSaving||goAnLacShiftLotoRevenue<=10000000} onClick={()=>void saveGoAnLacNightRewards()}>{goAnLacRewardSaving?"Đang Ghi Nhận…":"Ghi Nhận Thưởng 3 Người"}</button></div></section>}
        </section> :
      <section className="card overview-card management-overview">{overviewTicketVariancePanel}{profile?.role==="owner"&&<div className="overview-approval-bar"><button className={`overview-approval-button ${approvalCount>0?"has-pending":"all-clear"}`} onClick={()=>{setPanel("approvals");void loadApprovals();}}><span>{approvalCount>0?"Cần Duyệt":"Đã Duyệt Hết"}</span><strong>{approvalCount>0?`${approvalCount} Yêu Cầu Đang Chờ`:"Không Còn Yêu Cầu Chờ Xử Lý"}</strong><em>{approvalCount>0?"Yêu cầu cũ nhất được xếp trước →":"Xem toàn bộ lịch sử đã duyệt →"}</em></button></div>}<div className="overview-venue-revenue-buttons"><button className={overviewRevenueSelection==="company"?"active":""} aria-pressed={overviewRevenueSelection==="company"} onClick={()=>openRevenueVenue(null)}>Doanh Thu Công Ty</button>{["Đức Hòa","Go An Lạc","Liên Minh","Lộc Ninh"].map(name=>{const venue=venues.find(v=>v.name.toLowerCase().includes(name.toLowerCase()));const selected=!!venue&&overviewRevenueSelection===String(venue.id);return <button className={selected?"active":""} aria-pressed={selected} key={name} disabled={!venue} onClick={()=>venue&&openRevenueVenue(venue.id)}>Doanh Thu {name}</button>})}</div><div className="overview-revenue-dashboard"><div className="overview-revenue-heading"><div><p className="eyebrow">THỐNG KÊ DOANH THU</p><h3>Doanh Thu Theo Sân Khấu</h3><small>{overviewRevenue?new Date(overviewRevenue.date+"T12:00:00").toLocaleDateString("vi-VN"):"Chưa Có Dữ Liệu"}</small></div><div className="overview-revenue-controls"><label><span>Ngày Xem Doanh Thu</span><select value={overviewRevenueDate} onChange={event=>changeOverviewRevenueDate(event.target.value)}>{revenueHistoryDates().map(date=><option key={date} value={date}>{new Date(date+"T12:00:00").toLocaleDateString("vi-VN")}{date===localDateValue()?" · Hôm Nay":""}</option>)}</select></label><button onClick={()=>void loadOverviewRevenue(activeShift,overviewRevenueSelection&&overviewRevenueSelection!=="company"?Number(overviewRevenueSelection):null,overviewRevenueDate)} disabled={overviewRevenueLoading}>{overviewRevenueLoading?"Đang Tải…":"Làm Mới"}</button></div></div>{overviewRevenueKpis}<div className="overview-category-grid">{Object.entries(overviewCategoryLabels).map(([category,label])=><article key={category}><span>{label}</span><strong>{Number(overviewRevenue?.current.categories[category]||0).toLocaleString("vi-VN")} đ</strong></article>)}</div>{overviewCompanyFinanceSummary}{overviewStageFinanceSummary}</div>{overviewRewardSummary}</section>}
      <footer className="site-footer">{session.user.email} · {profile?.role === "owner" ? "Chủ Sở Hữu" : "Nhân Viên"}</footer>
    </main>}
  </div>;
}




















