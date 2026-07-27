//! Rust transcription of Pooltool's compliant Stronge cushion model.

use std::f64::consts::{FRAC_PI_2, PI};

fn phase_restitution(time: f64, omega_n: f64, restitution: f64) -> f64 {
    omega_n * time / restitution + FRAC_PI_2 * (1.0 - 1.0 / restitution)
}

fn numpy_isclose(value: f64, expected: f64) -> bool {
    (value - expected).abs() <= 1.0e-8 + 1.0e-5 * expected.abs()
}

fn bisect(mut function: impl FnMut(f64) -> f64, mut low: f64, mut high: f64) -> f64 {
    let mut low_value = function(low);
    let high_value = function(high);
    if low_value.abs() <= 1.0e-13 {
        return low;
    }
    if high_value.abs() <= 1.0e-13 {
        return high;
    }
    if low_value.signum() == high_value.signum() {
        // TOMS748 requires a bracket too. This fallback is only reached within
        // floating-point distance of one of the analytical regime boundaries.
        return if low_value.abs() < high_value.abs() {
            low
        } else {
            high
        };
    }
    for _ in 0..96 {
        let middle = 0.5 * (low + high);
        let value = function(middle);
        if value.abs() <= 1.0e-14 || high - low <= 1.0e-14 {
            return middle;
        }
        if value.signum() == low_value.signum() {
            low = middle;
            low_value = value;
        } else {
            high = middle;
        }
    }
    0.5 * (low + high)
}

fn initial_slip_displacement(
    time: f64,
    compression_duration: f64,
    normal_velocity: f64,
    friction: f64,
    eta_squared: f64,
    omega_n: f64,
    restitution: f64,
) -> f64 {
    let sine = if time <= compression_duration {
        (omega_n * time).sin()
    } else {
        phase_restitution(time, omega_n, restitution).sin()
    };
    -friction * normal_velocity * eta_squared / omega_n * sine
}

#[allow(clippy::too_many_arguments)]
fn initial_slip_velocity(
    time: f64,
    compression_duration: f64,
    tangent_velocity: f64,
    normal_velocity: f64,
    friction: f64,
    beta_ratio: f64,
    omega_n: f64,
    restitution: f64,
) -> f64 {
    if time <= compression_duration {
        tangent_velocity - friction * beta_ratio * normal_velocity * (1.0 - (omega_n * time).cos())
    } else {
        tangent_velocity
            - friction
                * beta_ratio
                * normal_velocity
                * (1.0 - restitution * phase_restitution(time, omega_n, restitution).cos())
    }
}

fn stick_velocity(
    time: f64,
    omega_t: f64,
    initial_velocity: f64,
    initial_displacement: f64,
    stick_time: f64,
) -> f64 {
    let phase = omega_t * (time - stick_time);
    omega_t * initial_displacement * phase.sin() + initial_velocity * phase.cos()
}

/// Return `(v_t_final, v_n_final)`.
pub(crate) fn resolve(
    tangent_velocity: f64,
    normal_velocity: f64,
    mass: f64,
    friction: f64,
    restitution: f64,
    omega_ratio: f64,
) -> (f64, f64) {
    debug_assert!(tangent_velocity <= 0.0);
    debug_assert!(normal_velocity < 0.0);
    const BETA_T: f64 = 3.5;
    const BETA_N: f64 = 1.0;
    const NORMAL_STIFFNESS: f64 = 1_000.0;

    let beta_ratio = BETA_T / BETA_N;
    let eta_squared = beta_ratio / omega_ratio.powi(2);
    let ratio = tangent_velocity / normal_velocity;
    let omega_n = (BETA_N * NORMAL_STIFFNESS / mass).sqrt();
    let omega_t = omega_n * (beta_ratio / eta_squared).sqrt();
    let compression_duration = PI / (2.0 * omega_n);
    let collision_duration = (1.0 + restitution) * compression_duration;

    let gross_slip_boundary =
        friction * ((1.0 + restitution) * beta_ratio - eta_squared / restitution);
    let tangent_final = if ratio > gross_slip_boundary {
        tangent_velocity - friction * normal_velocity * beta_ratio * (1.0 + restitution)
    } else if ratio < friction * eta_squared {
        let slip_time = if numpy_isclose(ratio, 0.0) {
            collision_duration
        } else if numpy_isclose(ratio, friction * eta_squared) {
            compression_duration
        } else {
            bisect(
                |time| {
                    (-ratio * (omega_t * time).sin()).abs()
                        - friction * eta_squared * omega_t / omega_n
                            * phase_restitution(time, omega_n, restitution).sin()
                },
                compression_duration,
                collision_duration,
            )
        };
        let velocity_at_slip = stick_velocity(slip_time, omega_t, tangent_velocity, 0.0, 0.0);
        velocity_at_slip
            + friction
                * normal_velocity
                * beta_ratio
                * restitution
                * (1.0
                    + (omega_n * slip_time / restitution + FRAC_PI_2 * (1.0 - 1.0 / restitution))
                        .cos())
    } else {
        let x = if ratio <= friction * beta_ratio {
            ((ratio / friction) - beta_ratio) / (eta_squared - beta_ratio)
        } else {
            ((ratio / friction) - beta_ratio)
                / (eta_squared / restitution - restitution * beta_ratio)
        }
        .clamp(-1.0, 1.0);
        let nondimensional_stick_time = if ratio <= friction * beta_ratio {
            2.0 / PI * x.acos()
        } else {
            2.0 / PI * (x.acos() - FRAC_PI_2 * (1.0 - 1.0 / restitution)) * restitution
        };
        let stick_time = compression_duration * nondimensional_stick_time;
        let displacement_at_stick = initial_slip_displacement(
            stick_time,
            compression_duration,
            normal_velocity,
            friction,
            eta_squared,
            omega_n,
            restitution,
        );
        let velocity_at_stick = initial_slip_velocity(
            stick_time,
            compression_duration,
            tangent_velocity,
            normal_velocity,
            friction,
            beta_ratio,
            omega_n,
            restitution,
        );
        let slip_time = if numpy_isclose(ratio, friction * eta_squared) {
            compression_duration
        } else if numpy_isclose(ratio, gross_slip_boundary) {
            collision_duration
        } else {
            bisect(
                |time| {
                    let phase = omega_t * (time - stick_time);
                    (omega_n / (friction * normal_velocity)
                        * (displacement_at_stick * phase.cos()
                            - velocity_at_stick / omega_t * phase.sin()))
                    .abs()
                        - eta_squared * phase_restitution(time, omega_n, restitution).sin()
                },
                compression_duration,
                collision_duration,
            )
        };
        let velocity_at_slip = stick_velocity(
            slip_time,
            omega_t,
            velocity_at_stick,
            displacement_at_stick,
            stick_time,
        );
        velocity_at_slip
            + beta_ratio
                * friction
                * normal_velocity
                * restitution
                * (1.0 + phase_restitution(slip_time, omega_n, restitution).cos())
    };

    // At t_f the restitution phase is π, therefore this is exactly -e*v_n0.
    let normal_final = restitution
        * normal_velocity
        * phase_restitution(collision_duration, omega_n, restitution).cos();
    (tangent_final, normal_final)
}

#[cfg(test)]
mod tests {
    use super::resolve;

    #[test]
    fn collision_regimes_match_pinned_pooltool_oracle() {
        for (tangent, expected_tangent) in [
            (-0.01, -0.004_879_650_413_924_258),
            (-0.2, -0.064_048_003_786_037_14),
            (-1.0, 0.462_790_657_052_450_26),
            (-3.0, -0.409_999_999_999_999_7),
        ] {
            let (resolved_tangent, normal) = resolve(tangent, -2.0, 0.170_097, 0.2, 0.85, 1.8);
            assert!((resolved_tangent - expected_tangent).abs() < 1.0e-12);
            assert!((normal - 1.7).abs() < 1.0e-12);
        }
    }
}
