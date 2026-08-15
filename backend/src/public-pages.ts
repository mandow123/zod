import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RuntimeConfig } from './config.js';

function escapeHtml(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function shell(input: Readonly<{
  nonce: string; title: string; eyebrow: string; body: string; support: string;
}>) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${input.title} · KAI CloudPay</title>
<style nonce="${input.nonce}">
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#101828;background:#f4f8f5}*{box-sizing:border-box}body{margin:0}main{width:min(720px,100%);margin:auto;padding:28px 18px 64px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:40px}.logo{width:52px;height:52px;border-radius:17px;background:#166534;color:white;display:grid;place-items:center;font-weight:900;font-size:28px}.brand b{font-size:21px}.brand small{display:block;color:#64748b;margin-top:2px}.eyebrow{color:#166534;font-size:12px;font-weight:900;letter-spacing:1.5px}.card{background:white;border:1px solid #dfe7e2;border-radius:28px;padding:clamp(22px,6vw,42px);box-shadow:0 12px 32px #10231a14}h1{font-size:clamp(30px,7vw,46px);line-height:1.13;margin:10px 0 14px}h2{font-size:20px;margin:28px 0 10px}p,li{color:#536273;line-height:1.75}.notice{padding:14px 16px;border-radius:16px;background:#e7f4ea;color:#0b4f2b;margin:18px 0}.support{font-size:13px;color:#64748b;margin-top:28px}.field{margin-top:16px}label{display:block;font-size:13px;font-weight:800;margin:0 0 7px}input,textarea{width:100%;border:1px solid #cfdbd3;border-radius:15px;padding:14px 15px;font:inherit;background:#fbfdfc;color:#101828}textarea{min-height:92px;resize:vertical}.actions{display:flex;gap:10px;margin-top:18px}button{border:0;border-radius:15px;padding:14px 18px;font:inherit;font-weight:800;cursor:pointer}button.primary{flex:1;background:#166534;color:white}button.secondary{background:#e7f4ea;color:#0b4f2b}button:disabled{opacity:.45;cursor:not-allowed}.status{display:none;margin-top:16px;padding:14px;border-radius:15px;line-height:1.6}.status.show{display:block}.status.ok{background:#e7f4ea;color:#0b4f2b}.status.error{background:#fff0f0;color:#b42318}.muted{font-size:12px;color:#7a8898}a{color:#166534;font-weight:700}@media(max-width:520px){.actions{flex-direction:column}.card{border-radius:23px}}
</style></head><body><main><div class="brand"><div class="logo">K</div><div><b>KAI CloudPay</b><small>企业算力任务中心</small></div></div>
<article class="card"><div class="eyebrow">${input.eyebrow}</div>${input.body}<p class="support">${input.support}</p></article></main></body></html>`;
}

function policyBody(kind: 'privacy' | 'terms', entity: string) {
  if (kind === 'terms') return `<h1>用户协议</h1><p>更新日期：2026年8月12日</p>
<div class="notice">本协议适用于 KAI CloudPay 原生移动应用，由 ${entity} 提供服务。</div>
<h2>服务范围</h2><p>CloudPay 提供算力需求发布、资源挂牌、订单、支付、交付、退款、争议举证、发票和账户管理。交易结果以服务端记录为准。</p>
<h2>账户安全</h2><p>用户应妥善保护手机号和设备。发现异常设备时，可在“我的 → 账户与设备”立即退出该设备。</p>
<h2>交易与履约</h2><p>价格、库存、服务等级和交付条件以创建订单时确认的快照为准。支付、退款和发票由已配置的合规渠道处理。</p>
<h2>内容与文件</h2><p>用户提交的资源信息、需求和争议证据应真实、合法且不侵犯第三方权利。上传文件会进行恶意内容检查。</p>
<h2>注销</h2><p>用户可在 App 内或<a href="/account/delete">公开注销页面</a>申请删除账户。申请后提供 7 天冷静期；依法必须保留的交易记录会在义务完成后再去标识化。</p>`;
  return `<h1>隐私政策</h1><p>更新日期：2026年8月12日</p>
<div class="notice">KAI CloudPay 仅为提供明确功能处理必要数据；不会出售个人信息。</div>
<h2>我们处理的数据</h2><ul><li>账户：手机号、显示名称、协议同意记录和安全审计记录。</li><li>设备：随机设备标识、平台、App 版本、登录会话和你主动开启后的推送凭证。</li><li>交易：需求、挂牌、订单、支付状态、交付、退款、争议和发票信息。</li><li>文件：争议证据与发票文件；文件经过完整性和恶意内容检查。</li><li>运行安全：必要的网络地址摘要、请求标识、异常和备份审计。</li></ul>
<h2>设备权限</h2><p>App 使用网络和可选通知权限；不申请位置、通讯录、相机、麦克风或相册权限。文件仅在用户主动选择上传时读取。</p>
<h2>存储与安全</h2><p>敏感字段加密保存，会话凭证存入系统安全存储。生产服务采用访问控制、操作审计、恶意文件扫描、监控与加密备份。</p>
<h2>共享与委托处理</h2><p>仅在完成短信、支付、推送、对象存储和法定义务所必要的范围内向已配置服务商传输数据；应用内消息不依赖系统推送。</p>
<h2>保存与删除</h2><p>用户可在“我的 → 账户与设备”或<a href="/account/delete">公开注销页面</a>提出删除申请。冷静期为 7 天；未结订单、退款、争议、发票或监管义务完成前，相关记录会依法保留。到期后账户标识、会话与推送凭证自动撤销并去标识化。</p>
<h2>你的权利</h2><p>你可以查看登录设备、关闭推送、撤销其他设备会话、申请或撤回账户注销，并通过下方联系方式提出访问、更正或删除请求。</p>`;
}

function deletionBody(nonce: string) {
  return `<h1>删除 CloudPay 账户</h1><p>即使已经卸载 App，也可以在这里完成删除申请。</p>
<div class="notice">验证账户手机号后，申请进入 7 天冷静期。未结订单、退款、争议、发票或供应方义务会依法处理完成后再去标识化。</div>
<div id="form"><div class="field"><label for="phone">账户手机号</label><input id="phone" inputmode="numeric" autocomplete="tel" maxlength="20" placeholder="请输入中国大陆手机号"></div>
<div class="field" id="codeField" hidden><label for="code">短信验证码</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码"></div>
<div class="field" id="reasonField" hidden><label for="reason">删除原因（选填）</label><textarea id="reason" maxlength="1000" placeholder="帮助我们改进服务"></textarea></div>
<div class="actions"><button class="secondary" id="reset" type="button" hidden>重新输入</button><button class="primary" id="submit" type="button">获取验证码</button></div>
<div class="status" id="status" role="status" aria-live="polite"></div><p class="muted">验证码仅用于本次身份确认。请勿向任何人透露验证码。</p></div>
<script nonce="${nonce}">
(()=>{const phone=document.querySelector('#phone'),code=document.querySelector('#code'),reason=document.querySelector('#reason'),submit=document.querySelector('#submit'),reset=document.querySelector('#reset'),status=document.querySelector('#status'),codeField=document.querySelector('#codeField'),reasonField=document.querySelector('#reasonField');let challengeId=null,busy=false;
const show=(message,ok=false)=>{status.textContent=message;status.className='status show '+(ok?'ok':'error')};
const call=async(path,body)=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(body)});let value;try{value=await response.json()}catch{throw new Error('服务返回了无法识别的数据。')}if(!response.ok)throw new Error(value?.error?.message||'服务暂时不可用。');return value};
reset.onclick=()=>{challengeId=null;phone.disabled=false;phone.value='';code.value='';reason.value='';codeField.hidden=true;reasonField.hidden=true;reset.hidden=true;submit.textContent='获取验证码';status.className='status'};
submit.onclick=async()=>{if(busy)return;busy=true;submit.disabled=true;status.className='status';try{const number=phone.value.replace(/\D/g,'');if(!challengeId){if(!/^1[3-9]\d{9}$/.test(number))throw new Error('请输入有效的中国大陆手机号。');const value=await call('/mobile/v1/auth/otp/request',{phone:number,purpose:'delete_account'});challengeId=value.challenge.challengeId;phone.disabled=true;codeField.hidden=false;reasonField.hidden=false;reset.hidden=false;submit.textContent='验证并申请删除';show('验证码已发送，请在 5 分钟内完成验证。',true)}else{if(!/^\d{6}$/.test(code.value))throw new Error('请输入 6 位验证码。');const verified=await call('/mobile/v1/auth/otp/verify',{phone:number,challengeId,code:code.value,purpose:'delete_account'});const deleted=await call('/mobile/v1/account/deletion/public',{reauthenticationToken:verified.result.reauthenticationToken,reason:reason.value});const until=new Date(deleted.request.coolingOffUntil).toLocaleString('zh-CN');document.querySelector('#form').innerHTML='<div class="notice"><b>删除申请已受理</b><br>冷静期截止：'+until+'。冷静期内可登录 App 撤回；存在未结义务时会在处理完成后执行去标识化。</div>'}}catch(error){show(error instanceof Error?error.message:'操作失败，请稍后重试。')}finally{busy=false;submit.disabled=false}}})();
</script>`;
}

export async function registerPublicPages(app: FastifyInstance, config: RuntimeConfig) {
  const entity = escapeHtml(config.LEGAL_ENTITY_NAME, 'KAI CloudPay 运营主体（待生产配置）');
  const support = `运营主体：${entity} · 支持邮箱：${escapeHtml(config.SUPPORT_EMAIL, '待生产配置')} · 支持电话：${escapeHtml(config.SUPPORT_PHONE, '待生产配置')}`;
  const page = (title: string, eyebrow: string, body: (nonce: string) => string) => {
    const nonce = randomBytes(18).toString('base64');
    const html = shell({ nonce, title, eyebrow, body: body(nonce), support });
    return { nonce, html };
  };
  const send = (reply: FastifyReply, rendered: ReturnType<typeof page>) => reply
    .header('Cache-Control', 'no-store, max-age=0')
    .header('Content-Security-Policy', `default-src 'none'; style-src 'nonce-${rendered.nonce}'; script-src 'nonce-${rendered.nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`)
    .header('Referrer-Policy', 'no-referrer')
    .type('text/html; charset=utf-8').send(rendered.html);

  app.get('/privacy', async (_request, reply) => send(reply, page('隐私政策', 'PRIVACY', () => policyBody('privacy', entity))));
  app.get('/terms', async (_request, reply) => send(reply, page('用户协议', 'TERMS', () => policyBody('terms', entity))));
  app.get('/account/delete', async (_request, reply) => send(reply, page('删除账户', 'ACCOUNT DELETION', deletionBody)));
}
