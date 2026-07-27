use crate::math::{EPSILON, Vec2, Vec3};
use crate::model::{
    BilliardsMode, CircularCushionSpec, LinearCushionSpec, PocketKind, PocketSpec, SpotSpec,
    TableSpec,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

const POOLTOOL_POCKET_DEPTH: f64 = 0.08;

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

    fn from_boundary(
        id: String,
        p1: Vec2,
        p2: Vec2,
        height: f64,
        nose_radius: f64,
        clockwise: bool,
    ) -> Self {
        let edge = p2 - p1;
        let length = edge.length();
        let inward = if clockwise {
            Vec2::new(edge.y, -edge.x)
        } else {
            Vec2::new(-edge.y, edge.x)
        } * (1.0 / length);
        let p1 = Vec3::new(p1.x, p1.y, height);
        let p2 = Vec3::new(p2.x, p2.y, height);
        Self {
            id,
            p1,
            p2,
            nose_radius,
            direction: CushionDirection::Side2,
            lx: inward.x,
            ly: inward.y,
            l0: -inward.dot(p1.xy()),
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

    fn from_boundary_vertex(id: String, center: Vec2, height: f64) -> Self {
        let center = Vec3::new(center.x, center.y, height);
        Self {
            id,
            center,
            radius: 0.0,
            aabb: Aabb::around(center.xy(), 0.0),
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

#[derive(Clone, Copy, Debug, Deserialize)]
struct ScenePoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneCoordinateSystem {
    origin: String,
    x_axis: String,
    y_axis: String,
    unit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneCanvas {
    width: f64,
    height: f64,
    coordinate_system: SceneCoordinateSystem,
    scale_mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum SceneElement {
    #[serde(rename = "image")]
    Image {
        name: String,
        role: String,
        visible: bool,
        rotation: f64,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        source: String,
    },
    #[serde(rename = "ellipse")]
    Ellipse {
        name: String,
        role: String,
        rotation: f64,
        cx: f64,
        cy: f64,
        rx: f64,
        ry: f64,
    },
    #[serde(rename = "polyline")]
    Polyline {
        name: String,
        role: String,
        rotation: f64,
        points: Vec<ScenePoint>,
        closed: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneDocument {
    format: String,
    format_version: u32,
    canvas: SceneCanvas,
    elements: Vec<SceneElement>,
}

#[derive(Clone, Copy, Debug)]
struct SceneEllipse {
    center: ScenePoint,
    rx: f64,
    ry: f64,
}

#[derive(Clone, Copy, Debug)]
struct SceneCalibration {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}

impl SceneCalibration {
    fn scale_x(self, table_width: f64) -> f64 {
        table_width / (self.right - self.left)
    }

    fn scale_y(self, table_height: f64) -> f64 {
        table_height / (self.bottom - self.top)
    }

    fn to_table(self, point: ScenePoint, table_width: f64, table_height: f64) -> Vec2 {
        Vec2::new(
            (point.x - self.left) * self.scale_x(table_width),
            (self.bottom - point.y) * self.scale_y(table_height),
        )
    }
}

#[derive(Clone, Debug)]
struct ChineseEightBallScene {
    canvas_width: f64,
    canvas_height: f64,
    boundary: Vec<ScenePoint>,
    holes: Vec<SceneEllipse>,
    calibration: SceneCalibration,
}

static CHINESE_EIGHT_BALL_SCENE: OnceLock<ChineseEightBallScene> = OnceLock::new();

#[derive(Clone, Copy)]
struct PocketTableParameters {
    l: f64,
    w: f64,
    outer_l: f64,
    outer_w: f64,
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
                l: 2.540,
                w: 1.270,
                outer_l: 2.830,
                outer_w: 1.550,
                cushion_width: 0.050,
                cushion_height: 0.036_576,
                cushion_nose_radius: 0.005,
                corner_pocket_width: 0.084,
                corner_pocket_angle: 0.0,
                corner_pocket_depth: 0.067_35,
                corner_pocket_radius: 0.088_9,
                corner_jaw_radius: 0.088_9,
                side_pocket_width: 0.088,
                side_pocket_angle: 0.0,
                side_pocket_depth: 0.051_59,
                side_pocket_radius: 0.053_19,
                side_jaw_radius: 0.066_9,
            },
            BilliardsMode::Snooker => Self {
                l: 3.569,
                w: 1.778,
                outer_l: 3.850,
                outer_w: 2.060,
                cushion_width: 0.047_63,
                cushion_height: 0.039,
                cushion_nose_radius: 0.005,
                corner_pocket_width: 0.086,
                corner_pocket_angle: 0.0,
                corner_pocket_depth: 0.067_35,
                corner_pocket_radius: 0.088_9,
                corner_jaw_radius: 0.088_9,
                side_pocket_width: 0.089,
                side_pocket_angle: 0.0,
                side_pocket_depth: 0.051_59,
                side_pocket_radius: 0.053_19,
                side_jaw_radius: 0.066_9,
            },
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct TableGeometry {
    pub table: TableSpec,
    pub linear_cushions: Vec<LinearCushion>,
    pub circular_cushions: Vec<CircularCushion>,
    /// Closed scene polylines describe finite segments. Their vertices are
    /// implicit circular collision features so a moving ball cannot pass
    /// through the numerical gap between two segment projections.
    pub boundary_vertices: Vec<CircularCushion>,
    pub pockets: Vec<PocketGeometry>,
}

impl TableGeometry {
    pub fn for_mode(mode: BilliardsMode) -> Self {
        let parameters = PocketTableParameters::for_mode(mode);
        if mode == BilliardsMode::ChineseEightBall {
            return create_chinese_eight_ball_geometry(parameters, chinese_eight_ball_scene());
        }
        let linear_cushions = create_linear_cushions(parameters);
        let circular_cushions = create_circular_cushions(parameters);
        let pockets = create_pockets(parameters);
        let table = build_table_spec(
            mode,
            parameters,
            &linear_cushions,
            &circular_cushions,
            &pockets,
        );
        Self {
            table,
            linear_cushions,
            circular_cushions,
            boundary_vertices: Vec::new(),
            pockets,
        }
    }
}

pub(crate) fn configure_table_scene(mode: BilliardsMode, value: Value) -> Result<(), String> {
    match mode {
        BilliardsMode::ChineseEightBall => {
            let scene = parse_chinese_eight_ball_scene(value)?;
            if (scene.canvas_width - 2_830.0).abs() > EPSILON
                || (scene.canvas_height - 1_550.0).abs() > EPSILON
            {
                return Err(
                    "Chinese eight-ball scene canvas must be 2830 by 1550 scene units".to_owned(),
                );
            }
            let _ = CHINESE_EIGHT_BALL_SCENE.set(scene);
            Ok(())
        }
        BilliardsMode::Snooker => {
            Err("snooker does not have a scene description file yet".to_owned())
        }
    }
}

pub(crate) fn ensure_table_scene_configured(mode: BilliardsMode) -> Result<(), String> {
    match mode {
        BilliardsMode::ChineseEightBall if CHINESE_EIGHT_BALL_SCENE.get().is_none() => {
            Err("Chinese eight-ball table scene has not been loaded".to_owned())
        }
        _ => Ok(()),
    }
}

fn chinese_eight_ball_scene() -> &'static ChineseEightBallScene {
    #[cfg(test)]
    {
        CHINESE_EIGHT_BALL_SCENE.get_or_init(load_test_chinese_eight_ball_scene)
    }
    #[cfg(not(test))]
    {
        CHINESE_EIGHT_BALL_SCENE
            .get()
            .expect("Chinese eight-ball scene must be configured before using the core")
    }
}

#[cfg(test)]
fn load_test_chinese_eight_ball_scene() -> ChineseEightBallScene {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../scenes/chinese-eight-ball/table.json");
    let json = std::fs::read_to_string(path).expect("read Chinese eight-ball scene fixture");
    let value = serde_json::from_str(&json).expect("parse Chinese eight-ball scene fixture JSON");
    parse_chinese_eight_ball_scene(value).expect("validate Chinese eight-ball scene fixture")
}

fn parse_chinese_eight_ball_scene(value: Value) -> Result<ChineseEightBallScene, String> {
    let document: SceneDocument =
        serde_json::from_value(value).map_err(|error| format!("invalid scene JSON: {error}"))?;
    if document.format != "tabletop.scene" || document.format_version != 1 {
        return Err("scene must use tabletop.scene/v1".to_owned());
    }
    let coordinates = &document.canvas.coordinate_system;
    if coordinates.origin != "top-left"
        || coordinates.x_axis != "right"
        || coordinates.y_axis != "down"
        || coordinates.unit != "scene-unit"
        || document.canvas.scale_mode != "contain"
    {
        return Err("scene coordinate system must be top-left/right/down scene units".to_owned());
    }
    if document.canvas.width <= 0.0 || document.canvas.height <= 0.0 {
        return Err("scene canvas dimensions must be positive".to_owned());
    }

    let mut table_count = 0;
    let mut boundary = None;
    let mut holes = Vec::new();
    for element in document.elements {
        match element {
            SceneElement::Image {
                name,
                role,
                visible,
                rotation,
                x,
                y,
                width,
                height,
                source,
            } if name == "table" => {
                table_count += 1;
                if role == "collision"
                    || !visible
                    || rotation != 0.0
                    || x != 0.0
                    || y != 0.0
                    || width != document.canvas.width
                    || height != document.canvas.height
                    || !source.starts_with("./")
                {
                    return Err(
                        "table must be a visible, unrotated canvas-sized image with a relative source"
                            .to_owned(),
                    );
                }
            }
            SceneElement::Polyline {
                name,
                role,
                rotation,
                points,
                closed,
            } if name == "boundary" && role != "visual" => {
                if boundary.is_some() {
                    return Err("scene must contain exactly one boundary polyline".to_owned());
                }
                if !closed || rotation != 0.0 || points.len() < 3 {
                    return Err(
                        "boundary must be an unrotated closed polyline with at least 3 points"
                            .to_owned(),
                    );
                }
                boundary = Some(points);
            }
            SceneElement::Ellipse {
                name,
                role,
                rotation,
                cx,
                cy,
                rx,
                ry,
            } if name == "hole" && role != "visual" => {
                if rotation != 0.0 || rx <= 0.0 || ry <= 0.0 {
                    return Err("holes must be unrotated ellipses with positive radii".to_owned());
                }
                holes.push(SceneEllipse {
                    center: ScenePoint { x: cx, y: cy },
                    rx,
                    ry,
                });
            }
            _ => {}
        }
    }
    if table_count != 1 {
        return Err(format!(
            "scene must contain exactly one image named table, found {table_count}"
        ));
    }
    let boundary =
        boundary.ok_or_else(|| "scene is missing the boundary collision polyline".to_owned())?;
    if holes.len() != 6 {
        return Err(format!(
            "scene must contain exactly 6 collision ellipses named hole, found {}",
            holes.len()
        ));
    }
    let calibration =
        derive_scene_calibration(&boundary, document.canvas.width, document.canvas.height)?;
    Ok(ChineseEightBallScene {
        canvas_width: document.canvas.width,
        canvas_height: document.canvas.height,
        boundary,
        holes,
        calibration,
    })
}

fn derive_scene_calibration(
    boundary: &[ScenePoint],
    canvas_width: f64,
    canvas_height: f64,
) -> Result<SceneCalibration, String> {
    let mut horizontal_levels = Vec::new();
    let mut vertical_extents = Vec::new();
    for index in 0..boundary.len() {
        let first = boundary[index];
        let second = boundary[(index + 1) % boundary.len()];
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        if dy.abs() <= 1.0e-9 && dx.abs() >= canvas_width * 0.25 {
            horizontal_levels.push(first.y);
        }
        if dx.abs() <= canvas_width * 0.01 && dy.abs() >= canvas_height * 0.25 {
            vertical_extents.extend([first.x, second.x]);
        }
    }
    if horizontal_levels.len() < 2 || vertical_extents.len() < 4 {
        return Err(
            "boundary must contain the long straight cushion edges used for calibration".to_owned(),
        );
    }
    let top = horizontal_levels
        .iter()
        .copied()
        .min_by(f64::total_cmp)
        .unwrap();
    let bottom = horizontal_levels
        .iter()
        .copied()
        .max_by(f64::total_cmp)
        .unwrap();
    let left = vertical_extents
        .iter()
        .copied()
        .min_by(f64::total_cmp)
        .unwrap();
    let right = vertical_extents
        .iter()
        .copied()
        .max_by(f64::total_cmp)
        .unwrap();
    if right - left <= EPSILON || bottom - top <= EPSILON {
        return Err("boundary calibration has zero width or height".to_owned());
    }
    Ok(SceneCalibration {
        left,
        right,
        top,
        bottom,
    })
}

fn create_chinese_eight_ball_geometry(
    parameters: PocketTableParameters,
    scene: &ChineseEightBallScene,
) -> TableGeometry {
    let boundary = scene
        .boundary
        .iter()
        .map(|point| {
            scene
                .calibration
                .to_table(*point, parameters.l, parameters.w)
        })
        .collect::<Vec<_>>();
    let signed_area = boundary
        .iter()
        .zip(boundary.iter().cycle().skip(1))
        .map(|(first, second)| first.x * second.y - second.x * first.y)
        .sum::<f64>()
        * 0.5;
    let clockwise = signed_area < 0.0;
    let linear_cushions = boundary
        .iter()
        .copied()
        .zip(boundary.iter().copied().cycle().skip(1))
        .enumerate()
        .filter_map(|(index, (first, second))| {
            if (second - first).length_squared() <= EPSILON {
                return None;
            }
            Some(LinearCushion::from_boundary(
                format!("scene-{index:02}"),
                first,
                second,
                parameters.cushion_height,
                parameters.cushion_nose_radius,
                clockwise,
            ))
        })
        .collect::<Vec<_>>();
    let circular_cushions = Vec::new();
    let boundary_vertices = boundary
        .iter()
        .copied()
        .enumerate()
        .map(|(index, point)| {
            CircularCushion::from_boundary_vertex(
                format!("scene-v{index:02}"),
                point,
                parameters.cushion_height,
            )
        })
        .collect();
    let scale_x = scene.calibration.scale_x(parameters.l);
    let scale_y = scene.calibration.scale_y(parameters.w);
    let mut holes = scene
        .holes
        .iter()
        .map(|hole| {
            let center = scene
                .calibration
                .to_table(hole.center, parameters.l, parameters.w);
            // The existing physics contract uses circular capture basins. Preserve
            // the authored ellipse's mean physical radius when X/Y scales differ.
            (center, (hole.rx * scale_x + hole.ry * scale_y) * 0.5)
        })
        .collect::<Vec<_>>();
    holes.sort_by(|first, second| first.0.y.total_cmp(&second.0.y));
    holes[..3].sort_by(|first, second| first.0.x.total_cmp(&second.0.x));
    holes[3..].sort_by(|first, second| first.0.x.total_cmp(&second.0.x));
    let ids = ["lb", "lc", "lt", "rb", "rc", "rt"];
    let pockets = holes
        .into_iter()
        .zip(ids)
        .map(|((center, radius), id)| {
            let center = Vec3::new(center.x, center.y, 0.0);
            PocketGeometry {
                id: id.to_owned(),
                center,
                radius,
                depth: POOLTOOL_POCKET_DEPTH,
                aabb: Aabb::around(center.xy(), radius),
            }
        })
        .collect::<Vec<_>>();
    let table = build_table_spec(
        BilliardsMode::ChineseEightBall,
        parameters,
        &linear_cushions,
        &circular_cushions,
        &pockets,
    );
    TableGeometry {
        table,
        linear_cushions,
        circular_cushions,
        boundary_vertices,
        pockets,
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

fn build_table_spec(
    mode: BilliardsMode,
    specs: PocketTableParameters,
    linear_cushions: &[LinearCushion],
    circular_cushions: &[CircularCushion],
    pockets: &[PocketGeometry],
) -> TableSpec {
    let pockets = pockets
        .iter()
        .map(|pocket| {
            let (kind, mouth_width, x, y) = match pocket.id.as_str() {
                "lb" => (PocketKind::Corner, specs.corner_pocket_width, 0.0, 0.0),
                "lc" => (
                    PocketKind::Side,
                    specs.side_pocket_width,
                    specs.l * 0.5,
                    0.0,
                ),
                "lt" => (PocketKind::Corner, specs.corner_pocket_width, specs.l, 0.0),
                "rb" => (PocketKind::Corner, specs.corner_pocket_width, 0.0, specs.w),
                "rc" => (
                    PocketKind::Side,
                    specs.side_pocket_width,
                    specs.l * 0.5,
                    specs.w,
                ),
                "rt" => (
                    PocketKind::Corner,
                    specs.corner_pocket_width,
                    specs.l,
                    specs.w,
                ),
                _ => unreachable!("standard table contains only six named pockets"),
            };
            PocketSpec {
                id: pocket.id.clone(),
                capture_radius: pocket.radius,
                capture_x: pocket.center.x,
                capture_y: pocket.center.y,
                kind,
                mouth_width,
                x,
                y,
            }
        })
        .collect();
    let linear_cushions = linear_cushions
        .iter()
        .map(|cushion| LinearCushionSpec {
            id: cushion.id.clone(),
            x1: cushion.p1.x,
            y1: cushion.p1.y,
            x2: cushion.p2.x,
            y2: cushion.p2.y,
        })
        .collect();
    let circular_cushions = circular_cushions
        .iter()
        .map(|cushion| CircularCushionSpec {
            id: cushion.id.clone(),
            x: cushion.center.x,
            y: cushion.center.y,
            radius: cushion.radius,
        })
        .collect();
    match mode {
        BilliardsMode::ChineseEightBall => TableSpec {
            mode,
            width: specs.l,
            height: specs.w,
            outer_width: specs.outer_l,
            outer_height: specs.outer_w,
            cushion_width: specs.cushion_width,
            ball_diameter: 0.05715 * 1.4,
            ball_mass: 0.170_097,
            baulk_line_x: Some(specs.l / 4.0),
            d_radius: None,
            pockets,
            linear_cushions,
            circular_cushions,
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
            outer_width: specs.outer_l,
            outer_height: specs.outer_w,
            cushion_width: specs.cushion_width,
            ball_diameter: 0.052_5,
            ball_mass: 0.140,
            baulk_line_x: Some(0.737),
            d_radius: Some(0.292),
            pockets,
            linear_cushions,
            circular_cushions,
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

pub fn table_spec(mode: BilliardsMode) -> TableSpec {
    TableGeometry::for_mode(mode).table
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
    fn table_profiles_match_the_supplied_dimensions() {
        let pool = PocketTableParameters::for_mode(BilliardsMode::ChineseEightBall);
        assert_eq!(
            [
                pool.l,
                pool.w,
                pool.outer_l,
                pool.outer_w,
                pool.cushion_width,
                pool.corner_pocket_width,
                pool.side_pocket_width,
            ],
            [2.540, 1.270, 2.830, 1.550, 0.050, 0.084, 0.088]
        );
        let snooker = PocketTableParameters::for_mode(BilliardsMode::Snooker);
        assert_eq!(
            [
                snooker.l,
                snooker.w,
                snooker.outer_l,
                snooker.outer_w,
                snooker.cushion_width,
                snooker.corner_pocket_width,
                snooker.side_pocket_width,
            ],
            [3.569, 1.778, 3.850, 2.060, 0.047_63, 0.086, 0.089]
        );
    }

    #[test]
    fn published_table_geometry_is_the_collision_geometry() {
        for mode in [BilliardsMode::ChineseEightBall, BilliardsMode::Snooker] {
            let geometry = TableGeometry::for_mode(mode);
            let (linear_count, circular_count) = match mode {
                BilliardsMode::ChineseEightBall => (41, 0),
                BilliardsMode::Snooker => (18, 12),
            };
            assert_eq!(geometry.linear_cushions.len(), linear_count);
            assert_eq!(geometry.circular_cushions.len(), circular_count);
            assert_eq!(
                geometry.boundary_vertices.len(),
                if mode == BilliardsMode::ChineseEightBall {
                    41
                } else {
                    0
                }
            );
            assert_eq!(geometry.pockets.len(), 6);

            for (collision, published) in geometry
                .linear_cushions
                .iter()
                .zip(&geometry.table.linear_cushions)
            {
                assert_eq!(collision.id, published.id);
                close(collision.p1.x, published.x1);
                close(collision.p1.y, published.y1);
                close(collision.p2.x, published.x2);
                close(collision.p2.y, published.y2);
            }
            for (collision, published) in geometry
                .circular_cushions
                .iter()
                .zip(&geometry.table.circular_cushions)
            {
                assert_eq!(collision.id, published.id);
                close(collision.center.x, published.x);
                close(collision.center.y, published.y);
                close(collision.radius, published.radius);
            }
            for (collision, published) in geometry.pockets.iter().zip(&geometry.table.pockets) {
                assert_eq!(collision.id, published.id);
                close(collision.center.x, published.capture_x);
                close(collision.center.y, published.capture_y);
                close(collision.radius, published.capture_radius);
            }
        }
    }

    #[test]
    fn table_specs_publish_nominal_mouths_and_capture_basins_separately() {
        let chinese = table_spec(BilliardsMode::ChineseEightBall);
        close(chinese.width, 2.540);
        close(chinese.height, 1.270);
        close(chinese.outer_width, 2.830);
        close(chinese.outer_height, 1.550);
        close(chinese.ball_diameter, 0.057_15 * 1.4);
        close(chinese.pockets[0].x, 0.0);
        close(chinese.pockets[0].y, 0.0);
        close(chinese.pockets[0].mouth_width, 0.084);
        close(chinese.pockets[1].x, 1.270);
        close(chinese.pockets[1].y, 0.0);
        close(chinese.pockets[1].mouth_width, 0.088);
        close(chinese.pockets[0].capture_x, -0.026_940_020_961_878_627);
        close(chinese.pockets[0].capture_y, -0.033_748_697_793_534_704);
        close(chinese.pockets[1].capture_x, 1.272_250_859_709_348);
        close(chinese.pockets[1].capture_y, -0.065_182_960_377_894_28);
        close(chinese.pockets[0].capture_radius, 0.071_056_560_266_567_37);
        close(chinese.pockets[1].capture_radius, 0.071_056_560_266_567_37);

        let snooker = table_spec(BilliardsMode::Snooker);
        close(snooker.width, 3.569);
        close(snooker.height, 1.778);
        close(snooker.outer_width, 3.850);
        close(snooker.outer_height, 2.060);
        close(snooker.ball_diameter, 0.052_5);
        close(snooker.pockets[0].mouth_width, 0.086);
        close(snooker.pockets[1].mouth_width, 0.089);
        close(snooker.baulk_line_x.unwrap(), 0.737);
        close(snooker.d_radius.unwrap(), 0.292);
        close(
            snooker
                .spots
                .iter()
                .find(|spot| spot.id == "black")
                .unwrap()
                .x,
            3.245,
        );
    }

    #[test]
    fn dynamic_chinese_scene_has_the_expected_collision_contract() {
        let scene = load_test_chinese_eight_ball_scene();
        assert_eq!(scene.boundary.len(), 41);
        assert_eq!(scene.holes.len(), 6);
        close(scene.canvas_width, 2_830.0);
        close(scene.canvas_height, 1_550.0);
        close(scene.calibration.left, 166.013_878_264_714_66);
        close(scene.calibration.right, 2_650.953_007_470_327_5);
        close(scene.calibration.top, 161.625_385_579_340_08);
        close(scene.calibration.bottom, 1_378.432_885_643_540_7);
    }
}
