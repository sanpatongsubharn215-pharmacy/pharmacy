/* api.js - ตัวเรียก GAS Web App แบบเลี่ยง CORS preflight
   ใส่ URL /exec ที่ได้จากการ Deploy ตรงนี้ */
const API_URL = 'https://script.google.com/macros/s/AKfycbwZvwQt7vugKJj2lr-CLiL7r2NWvJm2tiohwgUySb7oy9oNG7pAM1f8ZAWL-iMozpc4lQ/exec';

/**
 * เรียก action ฝั่ง GAS
 * - POST body เป็น text/plain (เลี่ยง preflight)
 * - ไม่ใส่ custom header ใด ๆ (Authorization ฯลฯ จะ trigger preflight แล้วพัง)
 * - ส่ง token ไปใน body
 */
async function api(action, params = {}) {
  const body = JSON.stringify(Object.assign({ action }, params, App.token ? { token: App.token } : {}));
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow'
    });
    const data = await res.json();
    if (data && data.code === 'AUTH') {
      App.handleAuthExpired();
      throw new Error(data.message || 'เซสชันหมดอายุ');
    }
    return data;
  } catch (err) {
    if (API_URL.indexOf('PASTE_YOUR') === 0) {
      throw new Error('ยังไม่ได้ตั้งค่า API_URL ใน js/api.js');
    }
    throw err;
  }
}
