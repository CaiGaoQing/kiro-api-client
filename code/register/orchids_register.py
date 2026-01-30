#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Orchids 自动注册脚本
支持命令行参数，可被 Node.js 后端调用
"""
import os
import sys
import io
import time
import random
import string
import re
import argparse
import requests
import html
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# 修复 Windows 编码问题
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ================= 配置区 =================
MAIL_API = "https://mail.chatgpt.org.uk"
MAIL_KEY = "gpt-test"  
TARGET_URL = "https://www.orchids.app/"

# ================= 工具函数 =================

def log(msg, level="INFO"):
    """输出日志，立即刷新确保 Node.js 能实时读取"""
    try:
        print(f"[{time.strftime('%H:%M:%S')}] [{level}] {msg}", flush=True)
    except UnicodeEncodeError:
        # 移除 emoji 再输出
        safe_msg = msg.encode('ascii', 'ignore').decode('ascii')
        print(f"[{time.strftime('%H:%M:%S')}] [{level}] {safe_msg}", flush=True)

def create_http_session():
    s = requests.Session()
    s.mount("https://", HTTPAdapter(max_retries=Retry(total=3, backoff_factor=1)))
    return s

http = create_http_session()

def generate_password():
    chars = string.ascii_letters + string.digits + "!@#$%"
    return ''.join(random.choice(chars) for _ in range(14))

def upload_to_server(client_key, server_url, auth_user="admin", auth_pass="admin123"):
    """将获取到的 cookie 上传到服务器"""
    # 输出 CLIENT_KEY 供 Node.js 解析
    print(f"CLIENT_KEY:{client_key}", flush=True)
    
    if not server_url:
        return True
        
    url = f"{server_url}/api/orchids/credentials"
    payload = {
        "name": f"auto-{int(time.time())}",
        "client_cookie": client_key,
        "weight": 1,
        "enabled": True
    }
    try:
        log(f"[UPLOAD] 正在上传 Key 到服务器...")
        r = requests.post(url, json=payload, auth=(auth_user, auth_pass), timeout=20)
        if r.status_code in [200, 201]:
            log("[OK] 服务器保存成功")
            return True
        else:
            log(f"[FAIL] 服务器保存失败: {r.status_code} - {r.text}", "ERR")
    except Exception as e:
        log(f"[FAIL] 上传过程发生异常: {e}", "ERR")
    return False

def create_temp_email():
    try:
        log("正在申请临时邮箱...")
        r = http.get(f"{MAIL_API}/api/generate-email", headers={"X-API-Key": MAIL_KEY}, timeout=20)
        if r.json().get('success'): 
            email = r.json()['data']['email']
            log(f"获取邮箱: {email}")
            return email
    except Exception as e:
        log(f"邮箱申请失败: {e}")
    return None

def wait_for_code(email):
    log(f"[MAIL] 正在监听 {email} 的收件箱 (120s)...")
    start = time.time()
    processed_ids = set()
    regex_strict = r'(?<!\d)(\d{6})(?!\d)'
    
    while time.time() - start < 120:
        try:
            r = http.get(f"{MAIL_API}/api/emails", params={"email": email}, headers={"X-API-Key": MAIL_KEY}, timeout=10)
            data = r.json().get('data', {}).get('emails', [])
            
            if data:
                latest_email = data[0]
                email_id = latest_email.get('id')
                
                if email_id not in processed_ids:
                    processed_ids.add(email_id)
                    subject = latest_email.get('subject', '')
                    raw_content = latest_email.get('content') or latest_email.get('html_content') or ''
                    
                    text_content = html.unescape(raw_content)
                    text_content = re.sub(r'<[^>]+>', ' ', text_content)
                    text_content = re.sub(r'\s+', ' ', text_content).strip()
                    
                    log(f"[MAIL] 收到新邮件: {subject}")
                    
                    for source in [subject, text_content]:
                        match = re.search(regex_strict, source)
                        if match:
                            code = match.group(1)
                            log(f"[OK] 提取到验证码: {code}")
                            return code
            
            time.sleep(3)
        except: pass
            
    return None

def register_one_account(current_idx, total_count, server_url, headless=False):
    """注册单个账号"""
    print(f"\n{'='*15} 开始注册第 {current_idx}/{total_count} 个账号 {'='*15}", flush=True)
    
    try:
        import undetected_chromedriver as uc
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
    except ImportError as e:
        log(f"[FAIL] 缺少依赖: {e}", "ERR")
        log("[INFO] 请运行: pip install undetected-chromedriver selenium", "ERR")
        return False
    
    options = uc.ChromeOptions()
    options.add_argument("--disable-blink-features=AutomationControlled") 
    options.add_argument("--no-first-run")
    if headless:
        options.add_argument("--headless=new")
    else:
        options.add_argument("--start-maximized")
    
    driver = None
    success = False
    
    try:
        # 自动检测 Chrome 版本，version_main=144 对应用户当前 Chrome 版本
        driver = uc.Chrome(version_main=144, options=options, use_subprocess=True)
        wait = WebDriverWait(driver, 30)  # 增加超时时间
        
        log(f"正在访问: {TARGET_URL}")
        driver.set_page_load_timeout(60)  # 页面加载超时60秒
        driver.get(TARGET_URL)
        
        # 等待页面完全加载
        time.sleep(3)
        
        # 1. 进入注册页
        try:
            sign_in_btn = wait.until(EC.element_to_be_clickable((By.XPATH, "//button[contains(text(), 'Sign in')] | //a[contains(text(), 'Sign in')]")))
            sign_in_btn.click()
        except Exception as e:
            log(f"[WARN] 点击 Sign in 失败，尝试备用方案: {e}")
            # 备用：直接访问登录页
            driver.get("https://www.orchids.app/sign-in")
            time.sleep(2)
        
        wait.until(EC.visibility_of_element_located((By.XPATH, "//*[contains(text(), 'Welcome back')] | //*[contains(text(), 'Sign in')]")))
        
        # 查找 Sign up 链接
        try:
            sign_up_link = wait.until(EC.element_to_be_clickable((By.XPATH, "//a[contains(text(), 'Sign up')] | //button[contains(text(), 'Sign up')]")))
            driver.execute_script("arguments[0].click();", sign_up_link)
        except:
            # 备用：直接访问注册页
            driver.get("https://www.orchids.app/sign-up")
            time.sleep(2)

        # 2. 填写表单
        wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input[name='emailAddress']")))
        email = create_temp_email()
        if not email: 
            return False
            
        password = generate_password()
        driver.find_element(By.CSS_SELECTOR, "input[name='emailAddress']").send_keys(email)
        driver.find_element(By.CSS_SELECTOR, "input[name='password']").send_keys(password)
        
        log("点击 Continue...")
        try:
            driver.find_element(By.XPATH, "//button[contains(text(), 'Continue')]").click()
        except:
            driver.find_element(By.CSS_SELECTOR, "input[name='password']").submit()

        # 3. 过校验
        log("[VERIFY] 进入验证模式...")
        pass_check = False
        for attempt in range(15):
            if len(driver.find_elements(By.CSS_SELECTOR, "input[inputmode='numeric']")) > 0:
                log("[OK] 验证码输入框已出现！")
                pass_check = True
                break
            
            # 尝试点击 Turnstile
            try:
                force_inject_turnstile(driver)
            except:
                pass
            time.sleep(2)
            
        if not pass_check:
            log("[FAIL] 暴力过校验超时，跳过此账号", "ERR")
            return False

        # 4. 验证码提取
        log("等待输入验证码...")
        otp_input = WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[inputmode='numeric']")))
        code = wait_for_code(email)
        
        if code:
            log(f"[INPUT] 填入验证码: {code}")
            otp_input.send_keys(code)
            time.sleep(5)
            
            # 用户名处理
            if "sign-up" in driver.current_url:
                try:
                    from selenium.webdriver.common.by import By
                    WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.NAME, "username")))
                    driver.find_element(By.NAME, "username").send_keys("User" + str(random.randint(1000, 9999)))
                    btns = driver.find_elements(By.TAG_NAME, "button")
                    for btn in btns:
                        if "Continue" in btn.text:
                            btn.click()
                            break
                except: pass 

            # 获取 Cookie
            log("[COOKIE] 使用 CDP 提取全局 Cookie...")
            try:
                res = driver.execute_cdp_cmd('Network.getAllCookies', {})
                all_cookies = res.get('cookies', [])
            except:
                all_cookies = driver.get_cookies()

            log(f"[COOKIE] 搜索到 {len(all_cookies)} 个全局 Cookie")
            client_key = None
            for cookie in all_cookies:
                name = cookie.get('name')
                domain = cookie.get('domain', '')
                value = cookie.get('value')
                
                if 'client' in name.lower():
                    log(f"[COOKIE] 发现相关 Cookie -> 名称: {name}, 域名: {domain}")

                if name == '__client':
                    client_key = value
                    if 'clerk' in domain:
                        log(f"[OK] 精准命中 Clerk 域名的 __client")
            
            if client_key:
                log(f"[OK] 成功提取 __client Key")
                upload_to_server(client_key, server_url)
                success = True
            else:
                log("[FAIL] 未能提取到 __client Key", "ERR")
        else:
            log("[FAIL] 验证码获取超时")

    except Exception as e:
        log(f"[FAIL] 注册流程出错: {e}", "ERR")
    finally:
        if driver:
            try:
                # 先停止 Chrome 进程再退出，避免 Windows 句柄错误
                driver.service.stop()
                driver.quit()
            except:
                pass
        
    return success

def force_inject_turnstile(driver):
    """尝试点击 Cloudflare Turnstile"""
    from selenium.webdriver.common.by import By
    
    js_find_and_click = """
    function findAndClick() {
        let clicked = false;
        function searchShadow(root) {
            if (clicked) return;
            let cb = root.querySelector('input[type="checkbox"], #turnstile-indicator');
            if (cb) { cb.click(); clicked = true; return; }
            let all = root.querySelectorAll('*');
            for (let el of all) {
                if (el.shadowRoot) searchShadow(el.shadowRoot);
            }
        }
        searchShadow(document);
        if (clicked) return true;
        let selectors = ['#cf-turnstile', '#turnstile-wrapper', '.cf-turnstile'];
        for (let s of selectors) {
            let el = document.querySelector(s);
            if (el && el.shadowRoot) {
                let cb = el.shadowRoot.querySelector('input[type="checkbox"]');
                if (cb) { cb.click(); return true; }
            }
        }
        return false;
    }
    return findAndClick();
    """
    
    if driver.execute_script(js_find_and_click):
        log("[CAPTCHA] 主页面命中验证码点击")
        return True

    iframes = driver.find_elements(By.TAG_NAME, "iframe")
    for index, frame in enumerate(iframes):
        try:
            driver.switch_to.frame(frame)
            if driver.execute_script(js_find_and_click):
                log(f"[CAPTCHA] Frame {index} 命中验证码点击")
                driver.switch_to.default_content()
                return True
            driver.switch_to.default_content()
        except:
            driver.switch_to.default_content()
    return False

def main():
    parser = argparse.ArgumentParser(description='Orchids 自动注册工具')
    parser.add_argument('--count', '-c', type=int, default=1, help='注册账号数量 (默认: 1)')
    parser.add_argument('--server', '-s', type=str, default='', help='服务器地址 (如: http://localhost:3000)')
    parser.add_argument('--headless', action='store_true', help='无头模式运行')
    args = parser.parse_args()
    
    total_num = args.count
    server_url = args.server
    success_count = 0
    
    log(f"[START] Orchids 自动注册启动")
    log(f"[CONFIG] 目标数量: {total_num}")
    log(f"[CONFIG] 服务器: {server_url or '无'}")
    log(f"[CONFIG] 无头模式: {'是' if args.headless else '否'}")

    for i in range(total_num):
        if register_one_account(i + 1, total_num, server_url, args.headless):
            success_count += 1
        
        if i < total_num - 1:
            # 批量注册时增加随机延迟，避免被检测
            wait_time = random.randint(8, 15)
            log(f"[WAIT] 休息 {wait_time} 秒后继续...")
            time.sleep(wait_time)

    print(f"\n{'='*30}", flush=True)
    print(f"任务结束！成功: {success_count}/{total_num}", flush=True)
    
    return 0 if success_count > 0 else 1

if __name__ == "__main__":
    sys.exit(main())
