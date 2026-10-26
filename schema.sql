-- ============================================================================
-- 内容整理大师 · 云数据库建表 SQL
-- 导出时间：2026-10-26（从线上环境 information_schema / pg_* 系统表还原）
-- 数据库：PostgreSQL（PostgREST 风格，auth.uid() 由云网关注入）
-- 角色约定：authenticated = 已登录用户；anon = 未登录访客
-- RLS 是两道独立的门：先 GRANT 赋权限，再 CREATE POLICY 限定行范围。
-- 漏了 GRANT 会报 42501（看似策略失效）。
-- ============================================================================

-- ============ 1. licenses 授权码（卡密） ============
-- 前端对这张表**零权限**（不 GRANT、不建 policy），防止有人直接 select 拖走全部卡密。
-- 卡密的签发与作废只能通过后端/SQL 进行。
CREATE TABLE IF NOT EXISTS public.licenses (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  quota_total integer NOT NULL DEFAULT 10,
  plan        text,
  expire_at   timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;
-- 注意：故意不加任何 policy。

-- ============ 2. redemptions 兑换记录 ============
-- 一张卡密只能被一个账号兑换一次（license_id 唯一约束）。
CREATE TABLE IF NOT EXISTS public.redemptions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id      text NOT NULL DEFAULT auth.uid(),
  license_id    bigint NOT NULL REFERENCES public.licenses(id),
  quota_granted integer NOT NULL,
  expire_at     timestamptz,
  bound_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemptions_license_unique UNIQUE (license_id)
);
ALTER TABLE public.redemptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.redemptions TO authenticated;
CREATE POLICY redemptions_read_own ON public.redemptions
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

-- ============ 3. usage_logs 用量日志 ============
CREATE TABLE IF NOT EXISTS public.usage_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   text NOT NULL DEFAULT auth.uid(),
  chars_in   integer,
  nodes      integer,
  sec        integer,
  ok         boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.usage_logs TO authenticated;
CREATE POLICY usage_logs_read_own ON public.usage_logs
  FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY usage_logs_insert_own ON public.usage_logs
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
-- identity 列背后的 sequence 需要显式授权（序列名约定：<表名>_<列名>_seq）
GRANT USAGE ON SEQUENCE public.usage_logs_id_seq TO authenticated;

-- ============ 4. redeem_license 兑换函数 ============
-- SECURITY DEFINER：以表所有者身份执行，是前端唯一可以“越过”licenses 零权限的入口。
-- 只接受完整 code，成功返回 quota，绝不回传卡密表数据。
CREATE OR REPLACE FUNCTION public.redeem_license(p_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid   text := auth.uid();
  v_id    bigint;
  v_total int;
  v_exp   timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('ok', false, 'msg', '请先登录');
  END IF;

  SELECT id, quota_total, expire_at
    INTO v_id, v_total, v_exp
    FROM public.licenses
   WHERE code = p_code;

  IF v_id IS NULL THEN
    RETURN json_build_object('ok', false, 'msg', '授权码不存在');
  END IF;

  IF v_exp IS NOT NULL AND v_exp < now() THEN
    RETURN json_build_object('ok', false, 'msg', '授权码已过期');
  END IF;

  IF EXISTS (SELECT 1 FROM public.redemptions WHERE license_id = v_id) THEN
    RETURN json_build_object('ok', false, 'msg', '授权码已被使用');
  END IF;

  INSERT INTO public.redemptions(owner_id, license_id, quota_granted, expire_at)
    VALUES (v_uid, v_id, v_total, v_exp);

  RETURN json_build_object('ok', true, 'quota', v_total);
END;
$function$;

-- ============================================================================
-- 额度计算约定（前端在 RLS 范围内直接算，无需额外函数）：
--   剩余次数 = SUM(未过期的 redemptions.quota_granted) - COUNT(usage_logs WHERE ok = true)
--
-- 发卡示例（需管理员身份执行）：
--   INSERT INTO public.licenses(code, quota_total, plan) VALUES ('XXXX-XXXX-XXXX', 5, '体验卡');
-- ============================================================================
