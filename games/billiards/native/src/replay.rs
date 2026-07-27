use crate::model::{Ball, SimulationEvent};

pub fn state_hash(
    balls: &[Ball],
    duration_ms: u32,
    events: &[SimulationEvent],
    pocketed_ball_ids: &[String],
) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&duration_ms.to_le_bytes());
    let mut ordered_balls: Vec<_> = balls.iter().collect();
    ordered_balls.sort_by(|first, second| first.id.cmp(&second.id));
    for ball in ordered_balls {
        push_string(&mut bytes, &ball.id);
        bytes.push(u8::from(ball.pocketed));
        for value in [ball.x, ball.y, ball.rotation] {
            bytes.extend_from_slice(&(value * 1_000_000.0).round().to_le_bytes());
        }
    }
    for event in events {
        bytes.extend_from_slice(&(event.at_seconds * 1_000_000_000.0).round().to_le_bytes());
        push_string(&mut bytes, &event.kind);
        for id in &event.ball_ids {
            push_string(&mut bytes, id);
        }
        if let Some(geometry_id) = &event.geometry_id {
            push_string(&mut bytes, geometry_id);
        }
    }
    for id in pocketed_ball_ids {
        push_string(&mut bytes, id);
    }

    let first = fnv64(&bytes, 0xcbf29ce484222325);
    let second = fnv64(&bytes, 0x84222325cbf29ce4);
    format!("{first:016x}{second:016x}")
}

pub fn legacy_checksum(canonical: &str) -> String {
    let mut hash = 0x811c9dc5_u32;
    for byte in canonical.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    format!("{hash:08x}")
}

fn fnv64(bytes: &[u8], offset: u64) -> u64 {
    let mut hash = offset;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn push_string(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
    bytes.extend_from_slice(value.as_bytes());
}
