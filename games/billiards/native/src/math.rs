use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

pub const EPSILON: f64 = 1.0e-9;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };

    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y
    }

    pub fn length_squared(self) -> f64 {
        self.dot(self)
    }

    pub fn length(self) -> f64 {
        self.length_squared().sqrt()
    }

    pub fn normalized(self) -> Self {
        let length = self.length();
        if length <= EPSILON {
            Self::ZERO
        } else {
            self / length
        }
    }

    pub fn perpendicular(self) -> Self {
        Self::new(-self.y, self.x)
    }
}

impl Add for Vec2 {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl AddAssign for Vec2 {
    fn add_assign(&mut self, rhs: Self) {
        self.x += rhs.x;
        self.y += rhs.y;
    }
}

impl Sub for Vec2 {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self::new(self.x - rhs.x, self.y - rhs.y)
    }
}

impl SubAssign for Vec2 {
    fn sub_assign(&mut self, rhs: Self) {
        self.x -= rhs.x;
        self.y -= rhs.y;
    }
}

impl Mul<f64> for Vec2 {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self::Output {
        Self::new(self.x * rhs, self.y * rhs)
    }
}

impl Div<f64> for Vec2 {
    type Output = Self;

    fn div(self, rhs: f64) -> Self::Output {
        Self::new(self.x / rhs, self.y / rhs)
    }
}

impl Neg for Vec2 {
    type Output = Self;

    fn neg(self) -> Self::Output {
        Self::new(-self.x, -self.y)
    }
}

pub fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    value.max(minimum).min(maximum)
}

pub fn quantize(value: f64, quantum: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let rounded = (value / quantum).round() * quantum;
    if rounded == -0.0 { 0.0 } else { rounded }
}

pub fn normalize_rotation(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let turn = std::f64::consts::TAU;
    quantize(
        (value + std::f64::consts::PI).rem_euclid(turn) - std::f64::consts::PI,
        1.0e-6,
    )
}

pub fn smallest_root_in_interval(coefficients: &[f64], minimum: f64, maximum: f64) -> Option<f64> {
    let mut roots = roots_in_interval(coefficients, minimum, maximum);
    roots.sort_by(f64::total_cmp);
    roots.into_iter().find(|root| *root > minimum + 1.0e-8)
}

pub fn roots_in_interval(coefficients: &[f64], minimum: f64, maximum: f64) -> Vec<f64> {
    let mut coefficients = coefficients.to_vec();
    while coefficients.len() > 1
        && coefficients
            .last()
            .is_some_and(|coefficient| coefficient.abs() <= 1.0e-14)
    {
        coefficients.pop();
    }
    let degree = coefficients.len().saturating_sub(1);
    if degree == 0 || !minimum.is_finite() || !maximum.is_finite() || maximum < minimum {
        return Vec::new();
    }
    if degree == 1 {
        let root = -coefficients[0] / coefficients[1];
        return if root >= minimum - EPSILON && root <= maximum + EPSILON {
            vec![root.clamp(minimum, maximum)]
        } else {
            Vec::new()
        };
    }

    let derivative: Vec<f64> = coefficients
        .iter()
        .enumerate()
        .skip(1)
        .map(|(power, coefficient)| *coefficient * power as f64)
        .collect();
    let mut critical = roots_in_interval(&derivative, minimum, maximum);
    critical.retain(|value| *value > minimum + EPSILON && *value < maximum - EPSILON);
    critical.sort_by(f64::total_cmp);
    critical.dedup_by(|first, second| (*first - *second).abs() <= 1.0e-9);

    let mut boundaries = Vec::with_capacity(critical.len() + 2);
    boundaries.push(minimum);
    boundaries.extend(critical.iter().copied());
    boundaries.push(maximum);

    let scale = coefficients
        .iter()
        .map(|value| value.abs())
        .sum::<f64>()
        .max(1.0);
    let tolerance = 1.0e-10 * scale;
    let mut roots = Vec::new();
    for point in &boundaries {
        if polynomial(&coefficients, *point).abs() <= tolerance {
            roots.push(*point);
        }
    }
    for pair in boundaries.windows(2) {
        let mut left = pair[0];
        let mut right = pair[1];
        let mut left_value = polynomial(&coefficients, left);
        let right_value = polynomial(&coefficients, right);
        if !left_value.is_finite()
            || !right_value.is_finite()
            || left_value == 0.0
            || right_value == 0.0
            || left_value.signum() == right_value.signum()
        {
            continue;
        }
        for _ in 0..72 {
            let middle = (left + right) * 0.5;
            let middle_value = polynomial(&coefficients, middle);
            if middle_value.abs() <= tolerance || right - left <= 1.0e-11 {
                left = middle;
                right = middle;
                break;
            }
            if middle_value.signum() == left_value.signum() {
                left = middle;
                left_value = middle_value;
            } else {
                right = middle;
            }
        }
        roots.push((left + right) * 0.5);
    }
    roots.sort_by(f64::total_cmp);
    roots.dedup_by(|first, second| (*first - *second).abs() <= 1.0e-8);
    roots
}

pub fn polynomial(coefficients: &[f64], x: f64) -> f64 {
    coefficients
        .iter()
        .rev()
        .fold(0.0, |value, coefficient| value * x + coefficient)
}
