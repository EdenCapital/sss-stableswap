use crate::state::STATE; use crate::events::Event;
pub fn get_events(cursor:u128,limit:u128)->Vec<Event>{
  STATE.with(|s|{ let s=s.borrow(); let st=std::cmp::min(cursor as usize,s.events.len()); let en=std::cmp::min(st+(limit as usize),s.events.len()); s.events[st..en].to_vec() })
}

pub fn get_events_latest(limit: u128) -> Vec<Event> {
    STATE.with(|s| {
        let s = s.borrow();
        let len = s.events.len();
        let l = limit as usize;
        let start = if len > l { len - l } else { 0 };
        s.events[start..len].to_vec()
    })
}
