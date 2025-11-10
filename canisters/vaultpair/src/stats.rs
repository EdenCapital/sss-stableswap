use candid::{CandidType, Deserialize};
use serde::{Serialize};

const HOURS_RING: usize = 168; // 7d * 24h

#[derive(CandidType, Serialize, Deserialize, Clone, Debug, Default)]
pub struct HourBucket {
    pub ts_hour: u64,     // 小时粒度的整点（秒/3600）
    pub volume_e6: u128,  // 成交量近似 (dx+dy)/2
    pub fee_e6: u128,     // 手续费（输入侧 fee）
    pub swaps: u32,       // 成交笔数
}

#[derive(CandidType, Serialize, Deserialize, Clone, Debug)]
pub struct RollingStats {
    pub base_hour: u64,
    pub buckets: Vec<HourBucket>, // 固定 168
}

impl Default for RollingStats {
    fn default() -> Self {
        Self { base_hour: 0, buckets: vec![HourBucket::default(); HOURS_RING] }
    }
}

impl RollingStats {
    pub fn with_now(now_sec: u64) -> Self {
        let mut rs = Self::default();
        rs.reset_all(now_sec / 3600);
        rs
    }
    fn reset_all(&mut self, hour_now: u64) {
        self.base_hour = hour_now - (HOURS_RING as u64) + 1;
        for i in 0..HOURS_RING {
            self.buckets[i] = HourBucket { ts_hour: self.base_hour + i as u64, volume_e6: 0, fee_e6: 0, swaps: 0 };
        }
    }
    fn ensure_advanced(&mut self, hour_now: u64) {
        if self.buckets.is_empty() { *self = Self::with_now(hour_now * 3600); return; }
        if hour_now + (HOURS_RING as u64) < self.base_hour || hour_now >= self.base_hour + (HOURS_RING as u64) {
            self.reset_all(hour_now);
            return;
        }
        // 纠正任何“缺小时”导致的错位
        for i in 0..HOURS_RING {
            let h = self.base_hour + i as u64;
            if self.buckets[i].ts_hour != h {
                self.buckets[i] = HourBucket { ts_hour: h, volume_e6: 0, fee_e6: 0, swaps: 0 };
            }
        }
    }
    pub fn record_swap(&mut self, now_sec: u64, dx_e6: u128, dy_e6: u128, fee_e6: u128) {
        let hour_now = now_sec / 3600;
        self.ensure_advanced(hour_now);
        let idx = (hour_now - self.base_hour) as usize;
        if idx >= HOURS_RING { return; }
        let vol = dx_e6.saturating_add(dy_e6) / 2;
        self.buckets[idx].volume_e6 = self.buckets[idx].volume_e6.saturating_add(vol);
        self.buckets[idx].fee_e6 = self.buckets[idx].fee_e6.saturating_add(fee_e6);
        self.buckets[idx].swaps = self.buckets[idx].swaps.saturating_add(1);
    }
    pub fn sum_last_hours(&self, now_sec: u64, hours: u32) -> (u128, u128, u32) {
        let hour_now = now_sec / 3600;
        let start_hour = hour_now.saturating_sub(hours as u64 - 1);
        let mut vol = 0u128; let mut fee = 0u128; let mut swaps = 0u32;
        for b in &self.buckets {
            if b.ts_hour >= start_hour && b.ts_hour <= hour_now {
                vol = vol.saturating_add(b.volume_e6);
                fee = fee.saturating_add(b.fee_e6);
                swaps = swaps.saturating_add(b.swaps);
            }
        }
        (vol, fee, swaps)
    }
    pub fn series(&self, now_sec: u64, hours: u32) -> Vec<HourBucket> {
        let hour_now = now_sec / 3600;
        let want = hours.min(HOURS_RING as u32) as usize;
        let mut out = Vec::with_capacity(want);
        for i in 0..want {
            let h = hour_now.saturating_sub(i as u64);
            let idx = if h < self.base_hour { None } else { Some((h - self.base_hour) as usize) };
            if let Some(ii) = idx {
                if ii < HOURS_RING { out.push(self.buckets[ii].clone()); continue; }
            }
            out.push(HourBucket { ts_hour: h, volume_e6: 0, fee_e6: 0, swaps: 0 });
        }
        out
    }
}
