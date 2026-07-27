use crate::math::{EPSILON, Vec2, Vec3};
use crate::model::{BilliardsMode, PocketKind, PocketSpec, SpotSpec, TableSpec};

#[derive(Clone, Copy, Debug)]
pub(crate) struct Aabb {
    pub minimum: Vec2,
    pub maximum: Vec2,
}

impl Aabb {
    pub fn from_motion(
        position: Vec2,
        velocity: Vec2,
        acceleration: Vec2,
        time: f64,
        pad: f64,
    ) -> Self {
        let end = position + velocity * time + acceleration * (0.5 * time * time);
        let extremum_x = axis_extremum(position.x, velocity.x, acceleration.x, time);
        let extremum_y = axis_extremum(position.y, velocity.y, acceleration.y, time);
        Self {
            minimum: Vec2::new(
                position.x.min(end.x).min(extremum_x) - pad,
                position.y.min(end.y).min(extremum_y) - pad,
            ),
            maximum: Vec2::new(
                position.x.max(end.x).max(extremum_x) + pad,
                position.y.max(end.y).max(extremum_y) + pad,
            ),
        }
    }

    pub fn around(center: Vec2, radius: f64) -> Self {
        Self {
            minimum: Vec2::new(center.x - radius, center.y - radius),
            maximum: Vec2::new(center.x + radius, center.y + radius),
        }
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.minimum.x <= other.maximum.x + EPSILON
            && self.maximum.x + EPSILON >= other.minimum.x
            && self.minimum.y <= other.maximum.y + EPSILON
            && self.maximum.y + EPSILON >= other.minimum.y
    }
}

fn axis_extremum(position: f64, velocity: f64, acceleration: f64, time: f64) -> f64 {
    if acceleration.abs() <= EPSILON {
        return position;
    }
    let extremum_time = (-velocity / acceleration).clamp(0.0, time);
    position + velocity * extremum_time + 0.5 * acceleration * extremum_time * extremum_time
}

/// Pooltool's `CushionDirection`: side one uses `line + R = 0`, side two
/// uses `line - R = 0`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CushionDirection {
    Side1,
    Side2,
}

#[derive(Clone, Debug)]
pub(crate) struct LinearCushion {
    pub id: String,
    pub p1: Vec3,
    pub p2: Vec3,
    // Kept for complete parity with Pooltool's segment contract. Its default
    // 2D detector treats the nose as a vertical plane/cylinder and therefore
    // does not include this rendering radius in the collision equation.
    #[allow(dead_code)]
    pub nose_radius: f64,
    pub direction: CushionDirection,
    pub lx: f64,
    pub ly: f64,
    pub l0: f64,
    pub aabb: Aabb,
}

impl LinearCushion {
    fn new(
        id: &str,
        p1_pool: Vec2,
        p2_pool: Vec2,
        height: f64,
        nose_radius: f64,
        direction: CushionDirection,
    ) -> Self {
        // Pooltool uses (short, long); the product contract uses (long, short).
        let p1 = Vec3::new(p1_pool.y, p1_pool.x, height);
        let p2 = Vec3::new(p2_pool.y, p2_pool.x, height);
        let dx = p2.x - p1.x;
        let dy = p2.y - p1.y;
        let (lx, ly, l0) = if dx == 0.0 {
            (1.0, 0.0, -p1.x)
        } else {
            (-dy / dx, 1.0, dy / dx * p1.x - p1.y)
        };
        Self {
            id: id.to_owned(),
            p1,
            p2,
            nose_radius,
            direction,
            lx,
            ly,
            l0,
            aabb: Aabb {
                minimum: Vec2::new(p1.x.min(p2.x), p1.y.min(p2.y)),
                maximum: Vec2::new(p1.x.max(p2.x), p1.y.max(p2.y)),
            },
        }
    }

    pub fn contains_projection(&self, point: Vec2) -> bool {
        let edge = self.p2.xy() - self.p1.xy();
        let denominator = edge.length_squared();
        if denominator <= EPSILON {
            return false;
        }
        let score = (point - self.p1.xy()).dot(edge) / denominator;
        (0.0..=1.0).contains(&score)
    }

    pub fn normal_3d(&self, point: Vec3) -> Vec3 {
        let axis = (self.p2 - self.p1).normalized();
        let relative = point - self.p1;
        (relative - axis * relative.dot(axis)).normalized()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CircularCushion {
    pub id: String,
    pub center: Vec3,
    pub radius: f64,
    pub aabb: Aabb,
}

impl CircularCushion {
    fn new(id: &str, center_pool: Vec2, height: f64, radius: f64) -> Self {
        let center = Vec3::new(center_pool.y, center_pool.x, height);
        Self {
            id: id.to_owned(),
            center,
            radius,
            aabb: Aabb::around(center.xy(), radius),
        }
    }

    pub fn normal_3d(&self, point: Vec3) -> Vec3 {
        (point - self.center).normalized()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PocketGeometry {
    pub id: String,
    pub center: Vec3,
    pub radius: f64,
    pub depth: f64,
    pub aabb: Aabb,
}

#[derive(Clone, Copy)]
struct PocketTableParameters {
    l: f64,
    w: f64,
    cushion_width: f64,
    cushion_height: f64,
    cushion_nose_radius: f64,
    corner_pocket_width: f64,
    corner_pocket_angle: f64,
    corner_pocket_depth: f64,
    corner_pocket_radius: f64,
    corner_jaw_radius: f64,
    side_pocket_width: f64,
    side_pocket_angle: f64,
    side_pocket_depth: f64,
    side_pocket_radius: f64,
    side_jaw_radius: f64,
}

impl PocketTableParameters {
    fn for_mode(mode: BilliardsMode) -> Self {
        match mode {
            BilliardsMode::ChineseEightBall => Self {
                l: 1.9812,
                w: 0.9906,
                cushion_width: 0.0508,
                cushion_height: 0.036_576,
                cushion_nose_radius: 0.005,
                corner_pocket_width: 0.118,
                corner_pocket_angle: 5.3,
                corner_pocket_depth: 0.0417,
                corner_pocket_radius: 0.062,
                corner_jaw_radius: 0.02095,
                side_pocket_width: 0.137,
                side_pocket_angle: 7.14,
                side_pocket_depth: 0.0685,
                side_pocket_radius: 0.0645,
                side_jaw_radius: 0.00795,
            },
            BilliardsMode::Snooker => Self {
                l: 3.569,
                w: 1.778,
                cushion_width: 0.04763,
                cushion_height: 0.039,
                cushion_nose_radius: 0.005,
                corner_pocket_width: 0.08014,
                corner_pocket_angle: 0.0,
                corner_pocket_depth: 0.06735,
                corner_pocket_radius: 0.0889,
                corner_jaw_radius: 0.0889,
                side_pocket_width: 0.08457,
                side_pocket_angle: 0.0,
                side_pocket_depth: 0.05159,
                side_pocket_radius: 0.05319,
                side_jaw_radius: 0.0669,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TableGeometry {
    pub table: TableSpec,
    pub linear_cushions: Vec<LinearCushion>,
    pub circular_cushions: Vec<CircularCushion>,
    pub pockets: Vec<PocketGeometry>,
}

impl TableGeometry {
    pub fn for_mode(mode: BilliardsMode) -> Self {
        let parameters = PocketTableParameters::for_mode(mode);
        let table = table_spec(mode);
        let linear_cushions = create_linear_cushions(parameters);
        let circular_cushions = create_circular_cushions(parameters);
        let pockets = create_pockets(parameters);
        Self {
            table,
            linear_cushions,
            circular_cushions,
            pockets,
        }
    }
}

fn create_linear_cushions(specs: PocketTableParameters) -> Vec<LinearCushion> {
    use CushionDirection::{Side1, Side2};
    let cw = specs.cushion_width;
    let ca = (specs.corner_pocket_angle + 45.0).to_radians();
    let sa = specs.side_pocket_angle.to_radians();
    let pw = specs.corner_pocket_width;
    let sw = specs.side_pocket_width;
    let h = specs.cushion_height;
    let dc = specs.corner_jaw_radius / ((std::f64::consts::FRAC_PI_2 + ca) / 2.0).tan();
    let ds = specs.side_jaw_radius / ((std::f64::consts::FRAC_PI_2 + sa) / 2.0).tan();
    let q = std::f64::consts::FRAC_1_SQRT_2;
    let p = |x, y| Vec2::new(x, y);
    let line = |id, p1, p2, direction| {
        LinearCushion::new(id, p1, p2, h, specs.cushion_nose_radius, direction)
    };

    vec![
        line(
            "3",
            p(0.0, pw * q + dc),
            p(0.0, (specs.l - sw) / 2.0 - ds),
            Side2,
        ),
        line(
            "6",
            p(0.0, (specs.l + sw) / 2.0 + ds),
            p(0.0, specs.l - pw * q - dc),
            Side2,
        ),
        line(
            "15",
            p(specs.w, pw * q + dc),
            p(specs.w, (specs.l - sw) / 2.0 - ds),
            Side1,
        ),
        line(
            "12",
            p(specs.w, (specs.l + sw) / 2.0 + ds),
            p(specs.w, specs.l - pw * q - dc),
            Side1,
        ),
        line(
            "18",
            p(pw * q + dc, 0.0),
            p(specs.w - pw * q - dc, 0.0),
            Side2,
        ),
        line(
            "9",
            p(pw * q + dc, specs.l),
            p(specs.w - pw * q - dc, specs.l),
            Side1,
        ),
        line(
            "5",
            p(-cw, (specs.l + sw) / 2.0 - cw * sa.sin()),
            p(-ds * sa.cos(), (specs.l + sw) / 2.0 - ds * sa.sin()),
            Side1,
        ),
        line(
            "4",
            p(-cw, (specs.l - sw) / 2.0 + cw * sa.sin()),
            p(-ds * sa.cos(), (specs.l - sw) / 2.0 + ds * sa.sin()),
            Side2,
        ),
        line(
            "13",
            p(specs.w + cw, (specs.l + sw) / 2.0 - cw * sa.sin()),
            p(
                specs.w + ds * sa.cos(),
                (specs.l + sw) / 2.0 - ds * sa.sin(),
            ),
            Side1,
        ),
        line(
            "14",
            p(specs.w + cw, (specs.l - sw) / 2.0 + cw * sa.sin()),
            p(
                specs.w + ds * sa.cos(),
                (specs.l - sw) / 2.0 + ds * sa.sin(),
            ),
            Side2,
        ),
        line(
            "1",
            p(pw * q - cw * ca.tan(), -cw),
            p(pw * q - dc * ca.sin(), -dc * ca.cos()),
            Side2,
        ),
        line(
            "2",
            p(-cw, pw * q - cw * ca.tan()),
            p(-dc * ca.cos(), pw * q - dc * ca.sin()),
            Side1,
        ),
        line(
            "8",
            p(pw * q - cw * ca.tan(), specs.l + cw),
            p(pw * q - dc * ca.sin(), specs.l + dc * ca.cos()),
            Side1,
        ),
        line(
            "7",
            p(-cw, specs.l - pw * q + cw * ca.tan()),
            p(-dc * ca.cos(), specs.l - pw * q + dc * ca.sin()),
            Side2,
        ),
        line(
            "11",
            p(specs.w + cw, specs.l - pw * q + cw * ca.tan()),
            p(specs.w + dc * ca.cos(), specs.l - pw * q + dc * ca.sin()),
            Side2,
        ),
        line(
            "10",
            p(specs.w - pw * q + cw * ca.tan(), specs.l + cw),
            p(specs.w - pw * q + dc * ca.sin(), specs.l + dc * ca.cos()),
            Side1,
        ),
        line(
            "16",
            p(specs.w + cw, pw * q - cw * ca.tan()),
            p(specs.w + dc * ca.cos(), pw * q - dc * ca.sin()),
            Side1,
        ),
        line(
            "17",
            p(specs.w - pw * q + cw * ca.tan(), -cw),
            p(specs.w - pw * q + dc * ca.sin(), -dc * ca.cos()),
            Side2,
        ),
    ]
}

fn create_circular_cushions(specs: PocketTableParameters) -> Vec<CircularCushion> {
    let pwq = specs.corner_pocket_width * std::f64::consts::FRAC_1_SQRT_2;
    let ca = (specs.corner_pocket_angle + 45.0).to_radians();
    let sa = specs.side_pocket_angle.to_radians();
    let dc = specs.corner_jaw_radius / ((std::f64::consts::FRAC_PI_2 + ca) / 2.0).tan();
    let ds = specs.side_jaw_radius / ((std::f64::consts::FRAC_PI_2 + sa) / 2.0).tan();
    let rc = specs.corner_jaw_radius;
    let rs = specs.side_jaw_radius;
    let half = specs.l / 2.0;
    let side_half = specs.side_pocket_width / 2.0;
    let p = |x, y| Vec2::new(x, y);
    let circle =
        |id, center, radius| CircularCushion::new(id, center, specs.cushion_height, radius);
    vec![
        circle("1t", p(pwq + dc, -rc), rc),
        circle("2t", p(-rc, pwq + dc), rc),
        circle("4t", p(-rs, half - side_half - ds), rs),
        circle("5t", p(-rs, half + side_half + ds), rs),
        circle("7t", p(-rc, specs.l - pwq - dc), rc),
        circle("8t", p(pwq + dc, specs.l + rc), rc),
        circle("10t", p(specs.w - pwq - dc, specs.l + rc), rc),
        circle("11t", p(specs.w + rc, specs.l - pwq - dc), rc),
        circle("13t", p(specs.w + rs, half + side_half + ds), rs),
        circle("14t", p(specs.w + rs, half - side_half - ds), rs),
        circle("16t", p(specs.w + rc, pwq + dc), rc),
        circle("17t", p(specs.w - pwq - dc, -rc), rc),
    ]
}

fn create_pockets(specs: PocketTableParameters) -> Vec<PocketGeometry> {
    // `Pocket.depth` is not part of the table layout specs in Pooltool. Every
    // pocket created by `create_pocket_table_pockets` therefore keeps the
    // canonical component default.
    const POOLTOOL_POCKET_DEPTH: f64 = 0.08;
    let corner_depth = specs.corner_pocket_depth * std::f64::consts::FRAC_1_SQRT_2;
    let source = [
        (
            "lb",
            Vec2::new(-corner_depth, -corner_depth),
            specs.corner_pocket_radius,
        ),
        (
            "lc",
            Vec2::new(-specs.side_pocket_depth, specs.l / 2.0),
            specs.side_pocket_radius,
        ),
        (
            "lt",
            Vec2::new(-corner_depth, specs.l + corner_depth),
            specs.corner_pocket_radius,
        ),
        (
            "rb",
            Vec2::new(specs.w + corner_depth, -corner_depth),
            specs.corner_pocket_radius,
        ),
        (
            "rc",
            Vec2::new(specs.w + specs.side_pocket_depth, specs.l / 2.0),
            specs.side_pocket_radius,
        ),
        (
            "rt",
            Vec2::new(specs.w + corner_depth, specs.l + corner_depth),
            specs.corner_pocket_radius,
        ),
    ];
    source
        .into_iter()
        .map(|(id, pool, radius)| {
            let center = Vec3::new(pool.y, pool.x, 0.0);
            PocketGeometry {
                id: id.to_owned(),
                center,
                radius,
                depth: POOLTOOL_POCKET_DEPTH,
                aabb: Aabb::around(center.xy(), radius),
            }
        })
        .collect()
}

pub fn table_spec(mode: BilliardsMode) -> TableSpec {
    let specs = PocketTableParameters::for_mode(mode);
    let pockets = create_pockets(specs)
        .into_iter()
        .map(|pocket| PocketSpec {
            capture_radius: pocket.radius,
            kind: if pocket.id == "lc" || pocket.id == "rc" {
                PocketKind::Side
            } else {
                PocketKind::Corner
            },
            x: pocket.center.x,
            y: pocket.center.y,
        })
        .collect();
    match mode {
        BilliardsMode::ChineseEightBall => TableSpec {
            mode,
            width: specs.l,
            height: specs.w,
            ball_diameter: 0.05715,
            ball_mass: 0.170_097,
            baulk_line_x: Some(specs.l / 4.0),
            d_radius: None,
            pockets,
            spots: vec![SpotSpec {
                id: "foot",
                x: specs.l * 0.75,
                y: specs.w * 0.5,
            }],
        },
        BilliardsMode::Snooker => TableSpec {
            mode,
            width: specs.l,
            height: specs.w,
            ball_diameter: 0.052_387_5,
            ball_mass: 0.140,
            baulk_line_x: Some(0.737),
            d_radius: Some(0.292),
            pockets,
            spots: vec![
                SpotSpec {
                    id: "green",
                    x: 0.737,
                    y: specs.w * 0.5 - 0.292,
                },
                SpotSpec {
                    id: "yellow",
                    x: 0.737,
                    y: specs.w * 0.5 + 0.292,
                },
                SpotSpec {
                    id: "brown",
                    x: 0.737,
                    y: specs.w * 0.5,
                },
                SpotSpec {
                    id: "blue",
                    x: specs.l * 0.5,
                    y: specs.w * 0.5,
                },
                SpotSpec {
                    id: "pink",
                    x: specs.l * 0.75,
                    y: specs.w * 0.5,
                },
                SpotSpec {
                    id: "black",
                    x: specs.l - 0.324,
                    y: specs.w * 0.5,
                },
            ],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1.0e-12,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn prebuilt_parameters_match_pooltool_collection() {
        let pool = PocketTableParameters::for_mode(BilliardsMode::ChineseEightBall);
        assert_eq!(
            [
                pool.l,
                pool.w,
                pool.cushion_width,
                pool.cushion_height,
                pool.cushion_nose_radius,
                pool.corner_pocket_width,
                pool.corner_pocket_angle,
                pool.corner_pocket_depth,
                pool.corner_pocket_radius,
                pool.corner_jaw_radius,
                pool.side_pocket_width,
                pool.side_pocket_angle,
                pool.side_pocket_depth,
                pool.side_pocket_radius,
                pool.side_jaw_radius,
            ],
            [
                1.9812, 0.9906, 0.0508, 0.036_576, 0.005, 0.118, 5.3, 0.0417, 0.062, 0.02095,
                0.137, 7.14, 0.0685, 0.0645, 0.00795,
            ]
        );
        let snooker = PocketTableParameters::for_mode(BilliardsMode::Snooker);
        assert_eq!(
            [
                snooker.l,
                snooker.w,
                snooker.cushion_width,
                snooker.cushion_height,
                snooker.cushion_nose_radius,
                snooker.corner_pocket_width,
                snooker.corner_pocket_angle,
                snooker.corner_pocket_depth,
                snooker.corner_pocket_radius,
                snooker.corner_jaw_radius,
                snooker.side_pocket_width,
                snooker.side_pocket_angle,
                snooker.side_pocket_depth,
                snooker.side_pocket_radius,
                snooker.side_jaw_radius,
            ],
            [
                3.569, 1.778, 0.04763, 0.039, 0.005, 0.08014, 0.0, 0.06735, 0.0889, 0.0889,
                0.08457, 0.0, 0.05159, 0.05319, 0.0669,
            ]
        );
    }

    #[test]
    fn seven_foot_showood_geometry_matches_pooltool_layout() {
        let geometry = TableGeometry::for_mode(BilliardsMode::ChineseEightBall);
        assert_eq!(geometry.linear_cushions.len(), 18);
        assert_eq!(geometry.circular_cushions.len(), 12);
        assert_eq!(geometry.pockets.len(), 6);
        close(geometry.table.width, 1.9812);
        close(geometry.table.height, 0.9906);
        close(geometry.table.ball_diameter, 0.05715);
        close(geometry.table.ball_mass, 0.170_097);

        let corner_angle = (5.3_f64 + 45.0).to_radians();
        let corner_offset = 0.02095 / ((std::f64::consts::FRAC_PI_2 + corner_angle) / 2.0).tan();
        let first = geometry
            .linear_cushions
            .iter()
            .find(|cushion| cushion.id == "3")
            .unwrap();
        close(
            first.p1.x,
            0.118 * std::f64::consts::FRAC_1_SQRT_2 + corner_offset,
        );
        close(first.p1.y, 0.0);
        close(first.p1.z, 0.036_576);
        assert_eq!(first.direction, CushionDirection::Side2);

        let first_tip = geometry
            .circular_cushions
            .iter()
            .find(|cushion| cushion.id == "1t")
            .unwrap();
        close(first_tip.center.x, -0.02095);
        close(
            first_tip.center.y,
            0.118 * std::f64::consts::FRAC_1_SQRT_2 + corner_offset,
        );
        close(first_tip.radius, 0.02095);

        let lower_left = geometry
            .pockets
            .iter()
            .find(|pocket| pocket.id == "lb")
            .unwrap();
        close(
            lower_left.center.x,
            -0.0417 * std::f64::consts::FRAC_1_SQRT_2,
        );
        close(
            lower_left.center.y,
            -0.0417 * std::f64::consts::FRAC_1_SQRT_2,
        );
        close(lower_left.radius, 0.062);
        close(lower_left.center.z, 0.0);
        close(lower_left.depth, 0.08);
    }

    #[test]
    fn generic_snooker_geometry_matches_pooltool_collection() {
        let geometry = TableGeometry::for_mode(BilliardsMode::Snooker);
        assert_eq!(geometry.linear_cushions.len(), 18);
        assert_eq!(geometry.circular_cushions.len(), 12);
        close(geometry.table.width, 3.569);
        close(geometry.table.height, 1.778);
        close(geometry.table.ball_diameter, 0.052_387_5);
        close(geometry.table.ball_mass, 0.140);
        close(geometry.pockets[0].radius, 0.0889);
        close(geometry.pockets[1].radius, 0.05319);
        close(geometry.pockets[1].center.y, -0.05159);
    }
}
