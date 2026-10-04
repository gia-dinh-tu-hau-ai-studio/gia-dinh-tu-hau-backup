import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.2";

const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(body:unknown,status=200)=>Response.json(body,{status,headers});

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers});
  if(req.method!=="POST")return reply({error:"Method not allowed"},405);
  try{
    const authHeader=req.headers.get("Authorization")||"";
    const token=authHeader.replace(/^Bearer\s+/i,"");
    if(!token)return reply({error:"Chưa đăng nhập"},401);
    const url=Deno.env.get("SUPABASE_URL")!;
    const anon=Deno.env.get("SUPABASE_ANON_KEY")!;
    const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient=createClient(url,anon,{global:{headers:{Authorization:authHeader}},auth:{persistSession:false}});
    const admin=createClient(url,service,{auth:{autoRefreshToken:false,persistSession:false}});
    const {data:{user},error:userError}=await userClient.auth.getUser(token);
    if(userError||!user)return reply({error:"Phiên đăng nhập không hợp lệ"},401);
    const {data:caller}=await admin.from("profiles").select("business_id,role,status").eq("user_id",user.id).single();
    if(!caller||caller.status!=="active"||caller.role!=="owner")return reply({error:"Chỉ Chủ sở hữu được quản lý người dùng"},403);
    const body=await req.json();
    const action=String(body.action||"create");
    if(action==="disable"){
      const targetUserId=String(body.target_user_id||"").trim();
      if(targetUserId===user.id)return reply({error:"Không thể tự xóa tài khoản Chủ sở hữu"},400);
      const {data:target}=await admin.from("profiles").select("user_id,role,status,full_name").eq("user_id",targetUserId).eq("business_id",caller.business_id).maybeSingle();
      if(!target)return reply({error:"Không tìm thấy người dùng"},404);
      if(target.role==="owner")return reply({error:"Tài khoản Chủ sở hữu được bảo vệ"},400);
      if(target.status!=="active")return reply({ok:true,already_disabled:true});
      const {error:profileError}=await admin.from("profiles").update({status:"disabled",updated_at:new Date().toISOString()}).eq("user_id",targetUserId).eq("business_id",caller.business_id);
      if(profileError)throw profileError;
      const {error:banError}=await admin.auth.admin.updateUserById(targetUserId,{ban_duration:"876000h"});
      if(banError)throw banError;
      return reply({ok:true,action:"disable",user_id:targetUserId});
    }
    if(action==="deactivate_employee"){
      const employeeId=Number(body.employee_id||0);
      if(!employeeId)return reply({error:"Hồ sơ nhân sự không hợp lệ"},400);
      const {data:employee}=await admin.from("employees").select("id,full_name,is_active").eq("id",employeeId).eq("business_id",caller.business_id).maybeSingle();
      if(!employee)return reply({error:"Không tìm thấy hồ sơ nhân sự"},404);
      const {data:linkedProfile}=await admin.from("profiles").select("user_id,role,status").eq("employee_id",employeeId).eq("business_id",caller.business_id).maybeSingle();
      if(linkedProfile?.role==="owner")return reply({error:"Không thể ngưng hoạt động nhân sự đang có quyền Chủ sở hữu"},400);
      const now=new Date();
      const leftOn=now.toLocaleDateString("en-CA",{timeZone:"Asia/Ho_Chi_Minh"});
      const {error:employeeError}=await admin.from("employees").update({is_active:false,left_on:leftOn}).eq("id",employeeId).eq("business_id",caller.business_id);
      if(employeeError)throw employeeError;
      if(linkedProfile){
        const {error:profileError}=await admin.from("profiles").update({status:"disabled",updated_at:now.toISOString()}).eq("user_id",linkedProfile.user_id).eq("business_id",caller.business_id);
        if(profileError)throw profileError;
        const {error:banError}=await admin.auth.admin.updateUserById(linkedProfile.user_id,{ban_duration:"876000h"});
        if(banError)throw banError;
      }
      return reply({ok:true,action:"deactivate_employee",employee_id:employeeId,account_disabled:Boolean(linkedProfile)});
    }
    if(action!=="create")return reply({error:"Thao tác không hợp lệ"},400);
    const username=String(body.username||"").trim();
    const password=String(body.password||"");
    const fullName=String(body.full_name||username).trim();
    const requestedRole=String(body.role||"");
    const accessLevel=Number(body.access_level||3);
    const role=requestedRole==="owner"?"owner":requestedRole==="manager"||accessLevel===1?"manager":"employee";
    const venueId=body.venue_id===null||body.venue_id===""?null:Number(body.venue_id);
    const employeeId=body.employee_id===null||body.employee_id===""?null:Number(body.employee_id);
    if(!/^[A-Za-z0-9._-]{3,32}$/.test(username))return reply({error:"Tên đăng nhập không hợp lệ"},400);
    if(password.length<8)return reply({error:"Mật khẩu phải có ít nhất 8 ký tự"},400);
    if(role==="manager"&&!venueId)return reply({error:"Tài khoản quản lý phải có sân khấu phụ trách"},400);
    if(role==="owner"&&fullName.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim()!=="MY TIEN")return reply({error:"Chỉ hồ sơ Mỹ Tiên được cấp thêm quyền Chủ sở hữu"},400);
    if(venueId){const {data:venue}=await admin.from("venues").select("id").eq("id",venueId).eq("business_id",caller.business_id).eq("is_active",true).maybeSingle();if(!venue)return reply({error:"Sân khấu không hợp lệ"},400);}
    if(employeeId){
      const {data:employee}=await admin.from("employees").select("id").eq("id",employeeId).eq("business_id",caller.business_id).eq("is_active",true).maybeSingle();
      if(!employee)return reply({error:"Hồ sơ nhân sự không hợp lệ"},400);
      const {data:linked}=await admin.from("profiles").select("user_id").eq("employee_id",employeeId).maybeSingle();
      if(linked)return reply({error:"Nhân sự này đã có tài khoản đăng nhập"},409);
    }
    const {data:existing}=await admin.from("profiles").select("user_id").ilike("username",username).maybeSingle();
    if(existing)return reply({error:"Tên đăng nhập đã tồn tại"},409);
    const email=username.toLowerCase()+"@giadinh-tuhau.internal";
    const modules=role==="owner"?["overview","loto","game","water","kiosk","employees","revenue","expense","approvals"]:role==="manager"?["overview","loto","game","water","kiosk","employees","revenue","expense"]:["employees"];
    const {data:created,error:createError}=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:fullName},app_metadata:{internal_username:username,access_level:accessLevel,venue_id:venueId,role}});
    if(createError||!created.user)throw createError||new Error("Không tạo được tài khoản");
    const {error:profileError}=await admin.from("profiles").upsert({user_id:created.user.id,business_id:caller.business_id,email,full_name:fullName,username,role,status:"active",access_level:role==="employee"?3:accessLevel,venue_id:venueId,employee_id:employeeId,allowed_modules:modules,must_change_password:true},{onConflict:"user_id"});
    if(profileError){await admin.auth.admin.deleteUser(created.user.id);throw profileError;}
    if(venueId)await admin.from("user_venue_access").upsert({user_id:created.user.id,venue_id:venueId},{onConflict:"user_id,venue_id"});
    return reply({ok:true,action:"create",user_id:created.user.id,username,role,venue_id:venueId,employee_id:employeeId});
  }catch(error){return reply({error:error instanceof Error?error.message:"Không quản lý được người dùng"},400);}
});
