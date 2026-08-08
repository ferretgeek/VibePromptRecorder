use crate::{
    error::{AppError, AppResult},
    models::RemoteImageData,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{
    Url,
    blocking::Client,
    header::{CONTENT_LENGTH, CONTENT_TYPE, LOCATION},
    redirect::Policy,
};
use std::{
    io::Read,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    time::Duration,
};

const MAX_REMOTE_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_REDIRECTS: usize = 4;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 40_000_000;
const MAX_IMAGE_FRAMES: usize = 256;

fn private_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, _, _] = address.octets();
    address.is_unspecified()
        || address.is_loopback()
        || address.is_private()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_multicast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || a >= 240
}

fn private_ipv6(address: Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return private_ipv4(mapped);
    }
    let segments = address.segments();
    address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || !(0x2000..=0x3fff).contains(&segments[0])
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}

fn private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => private_ipv4(address),
        IpAddr::V6(address) => private_ipv6(address),
    }
}

fn validated_target(url: &Url) -> AppResult<(String, SocketAddr)> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(AppError::Validation(
            "远程图片只允许无凭据的 HTTP 或 HTTPS 地址".into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppError::Validation("远程图片地址缺少主机名".into()))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| AppError::Validation("远程图片端口无效".into()))?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| AppError::Validation(format!("远程图片域名解析失败：{error}")))?
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(AppError::Validation("远程图片域名没有可用地址".into()));
    }
    if addresses
        .iter()
        .any(|address| private_address(address.ip()))
    {
        return Err(AppError::Validation(
            "已阻止解析到本机、内网或保留地址的远程图片".into(),
        ));
    }
    Ok((host.to_string(), addresses[0]))
}

fn allowed_content_type(value: &str) -> Option<&'static str> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    match mime.as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" => Some("image/bmp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        _ => None,
    }
}

fn checked_dimensions(width: u32, height: u32) -> AppResult<()> {
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_IMAGE_PIXELS
    {
        return Err(AppError::Validation(
            "远程图片画布尺寸过大或无效，已拒绝解码".into(),
        ));
    }
    Ok(())
}

fn be_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.try_into().ok()?))
}

fn le_u32(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}

fn inspect_gif(bytes: &[u8]) -> AppResult<()> {
    let width = u16::from_le_bytes(bytes[6..8].try_into().unwrap()).into();
    let height = u16::from_le_bytes(bytes[8..10].try_into().unwrap()).into();
    checked_dimensions(width, height)?;
    let packed = bytes[10];
    let mut index = 13_usize;
    if packed & 0x80 != 0 {
        index = index.saturating_add(3 * (1_usize << (usize::from(packed & 0x07) + 1)));
    }
    let mut frames = 0_usize;
    while index < bytes.len() {
        match bytes[index] {
            0x3b => break,
            0x2c => {
                frames += 1;
                if frames > MAX_IMAGE_FRAMES || index + 10 > bytes.len() {
                    return Err(AppError::Validation("GIF 帧数过多或结构损坏".into()));
                }
                let descriptor = bytes[index + 9];
                index += 10;
                if descriptor & 0x80 != 0 {
                    index =
                        index.saturating_add(3 * (1_usize << (usize::from(descriptor & 0x07) + 1)));
                }
                index = index.saturating_add(1);
                loop {
                    let size = *bytes
                        .get(index)
                        .ok_or_else(|| AppError::Validation("GIF 数据块不完整".into()))?
                        as usize;
                    index += 1;
                    if size == 0 {
                        break;
                    }
                    index = index
                        .checked_add(size)
                        .filter(|end| *end <= bytes.len())
                        .ok_or_else(|| AppError::Validation("GIF 数据块越界".into()))?;
                }
            }
            0x21 => {
                index = index.saturating_add(2);
                loop {
                    let size = *bytes
                        .get(index)
                        .ok_or_else(|| AppError::Validation("GIF 扩展块不完整".into()))?
                        as usize;
                    index += 1;
                    if size == 0 {
                        break;
                    }
                    index = index
                        .checked_add(size)
                        .filter(|end| *end <= bytes.len())
                        .ok_or_else(|| AppError::Validation("GIF 扩展块越界".into()))?;
                }
            }
            _ => return Err(AppError::Validation("GIF 结构损坏".into())),
        }
    }
    if frames == 0 {
        return Err(AppError::Validation("GIF 不包含可显示帧".into()));
    }
    Ok(())
}

fn inspect_jpeg(bytes: &[u8]) -> AppResult<()> {
    let mut index = 2_usize;
    while index + 4 <= bytes.len() {
        if bytes[index] != 0xff {
            index += 1;
            continue;
        }
        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }
        let marker = *bytes
            .get(index)
            .ok_or_else(|| AppError::Validation("JPEG 结构不完整".into()))?;
        index += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if matches!(marker, 0x01 | 0xd0..=0xd7) {
            continue;
        }
        let length = u16::from_be_bytes(
            bytes
                .get(index..index + 2)
                .and_then(|value| value.try_into().ok())
                .ok_or_else(|| AppError::Validation("JPEG 段长度损坏".into()))?,
        ) as usize;
        if length < 2 || index + length > bytes.len() {
            return Err(AppError::Validation("JPEG 段越界".into()));
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 7 {
                return Err(AppError::Validation("JPEG 尺寸段不完整".into()));
            }
            let height = u16::from_be_bytes(bytes[index + 3..index + 5].try_into().unwrap()).into();
            let width = u16::from_be_bytes(bytes[index + 5..index + 7].try_into().unwrap()).into();
            return checked_dimensions(width, height);
        }
        index += length;
    }
    Err(AppError::Validation("JPEG 缺少有效画布尺寸".into()))
}

fn inspect_webp(bytes: &[u8]) -> AppResult<()> {
    let mut index = 12_usize;
    let mut dimensions = None;
    let mut frames = 0_usize;
    while index + 8 <= bytes.len() {
        let kind = &bytes[index..index + 4];
        let size = le_u32(&bytes[index + 4..index + 8])
            .ok_or_else(|| AppError::Validation("WebP 块大小无效".into()))?
            as usize;
        let data = index + 8;
        let end = data
            .checked_add(size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| AppError::Validation("WebP 数据块越界".into()))?;
        if kind == b"VP8X" && size >= 10 {
            let width = 1
                + u32::from(bytes[data + 4])
                + (u32::from(bytes[data + 5]) << 8)
                + (u32::from(bytes[data + 6]) << 16);
            let height = 1
                + u32::from(bytes[data + 7])
                + (u32::from(bytes[data + 8]) << 8)
                + (u32::from(bytes[data + 9]) << 16);
            dimensions = Some((width, height));
        } else if kind == b"VP8 " && size >= 10 && bytes[data + 3..data + 6] == [0x9d, 0x01, 0x2a] {
            let width = u16::from_le_bytes(bytes[data + 6..data + 8].try_into().unwrap()) & 0x3fff;
            let height =
                u16::from_le_bytes(bytes[data + 8..data + 10].try_into().unwrap()) & 0x3fff;
            dimensions = Some((width.into(), height.into()));
        } else if kind == b"VP8L" && size >= 5 && bytes[data] == 0x2f {
            let bits = le_u32(&bytes[data + 1..data + 5]).unwrap();
            dimensions = Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1));
        } else if kind == b"ANMF" {
            frames += 1;
        }
        index = end + (size & 1);
    }
    if frames > MAX_IMAGE_FRAMES {
        return Err(AppError::Validation("WebP 动画帧数超过安全上限".into()));
    }
    let (width, height) =
        dimensions.ok_or_else(|| AppError::Validation("WebP 缺少可验证的画布尺寸".into()))?;
    checked_dimensions(width, height)
}

fn inspect_image(bytes: &[u8]) -> AppResult<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.len() >= 24 {
        let width = be_u32(&bytes[16..20]).unwrap();
        let height = be_u32(&bytes[20..24]).unwrap();
        checked_dimensions(width, height)?;
        if bytes.windows(4).filter(|chunk| *chunk == b"fcTL").count() > MAX_IMAGE_FRAMES {
            return Err(AppError::Validation("PNG 动画帧数超过安全上限".into()));
        }
        return Ok("image/png");
    }
    if (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) && bytes.len() >= 13 {
        inspect_gif(bytes)?;
        return Ok("image/gif");
    }
    if bytes.starts_with(b"\xff\xd8") {
        inspect_jpeg(bytes)?;
        return Ok("image/jpeg");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        inspect_webp(bytes)?;
        return Ok("image/webp");
    }
    if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        let width = le_u32(&bytes[18..22]).unwrap();
        let height = i32::from_le_bytes(bytes[22..26].try_into().unwrap()).unsigned_abs();
        checked_dimensions(width, height)?;
        return Ok("image/bmp");
    }
    if bytes.starts_with(&[0, 0, 1, 0]) && bytes.len() >= 6 {
        let count = u16::from_le_bytes(bytes[4..6].try_into().unwrap()) as usize;
        if count == 0 || count > MAX_IMAGE_FRAMES || bytes.len() < 6 + count * 16 {
            return Err(AppError::Validation("ICO 图像数量过多或结构损坏".into()));
        }
        for entry in bytes[6..6 + count * 16].chunks_exact(16) {
            let width = if entry[0] == 0 {
                256
            } else {
                u32::from(entry[0])
            };
            let height = if entry[1] == 0 {
                256
            } else {
                u32::from(entry[1])
            };
            checked_dimensions(width, height)?;
        }
        return Ok("image/x-icon");
    }
    Err(AppError::Validation(
        "远程响应内容不是受支持的真实图片格式".into(),
    ))
}

pub fn fetch(url: &str) -> AppResult<RemoteImageData> {
    let mut current =
        Url::parse(url).map_err(|_| AppError::Validation("远程图片地址格式无效".into()))?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, address) = validated_target(&current)?;
        let client = Client::builder()
            .redirect(Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .resolve(&host, address)
            .build()
            .map_err(|error| AppError::Validation(format!("无法创建安全图片请求：{error}")))?;
        let response = client
            .get(current.clone())
            .header(
                "Accept",
                "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/x-icon",
            )
            .header("User-Agent", "VibePromptRecorder/0.1")
            .send()
            .map_err(|error| AppError::Validation(format!("远程图片请求失败：{error}")))?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(AppError::Validation("远程图片重定向次数过多".into()));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| AppError::Validation("远程图片重定向地址无效".into()))?;
            current = current
                .join(location)
                .map_err(|_| AppError::Validation("远程图片重定向地址无效".into()))?;
            continue;
        }
        if !response.status().is_success() {
            return Err(AppError::Validation(format!(
                "远程图片服务器返回 {}",
                response.status()
            )));
        }
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|size| size > MAX_REMOTE_IMAGE_BYTES)
        {
            return Err(AppError::Validation("远程图片超过 20 MiB 安全上限".into()));
        }
        let declared_content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(allowed_content_type)
            .ok_or_else(|| AppError::Validation("远程地址未返回受支持的图片格式".into()))?;
        let mut bytes = Vec::new();
        response
            .take(MAX_REMOTE_IMAGE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_REMOTE_IMAGE_BYTES {
            return Err(AppError::Validation("远程图片超过 20 MiB 安全上限".into()));
        }
        let content_type = inspect_image(&bytes)?;
        if content_type != declared_content_type {
            return Err(AppError::Validation(
                "远程图片声明格式与实际文件内容不一致".into(),
            ));
        }
        let byte_count = bytes.len() as u64;
        return Ok(RemoteImageData {
            data_url: format!("data:{content_type};base64,{}", STANDARD.encode(bytes)),
            byte_count,
        });
    }
    Err(AppError::Validation("远程图片重定向处理失败".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_network_ranges_are_rejected() {
        for address in [
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1)),
            IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6("fd00::1".parse().expect("unique local address")),
            IpAddr::V6("fe80::1".parse().expect("link-local address")),
            IpAddr::V6(Ipv6Addr::from([
                0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
            ])),
        ] {
            assert!(private_address(address), "{address}");
        }
        assert!(!private_address("8.8.8.8".parse().expect("public")));
        assert!(!private_address(
            "2606:4700:4700::1111".parse().expect("public")
        ));
    }

    #[test]
    fn executable_and_svg_responses_are_not_accepted_as_images() {
        assert_eq!(
            allowed_content_type("image/png; charset=binary"),
            Some("image/png")
        );
        assert_eq!(allowed_content_type("image/svg+xml"), None);
        assert_eq!(allowed_content_type("image/avif"), None);
        assert_eq!(allowed_content_type("application/octet-stream"), None);
        assert!(inspect_image(b"MZ executable").is_err());
        assert!(inspect_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
    }

    #[test]
    fn avif_is_rejected_without_a_trusted_iso_bmff_parser() {
        let mut avif = vec![0_u8; 40];
        avif[4..8].copy_from_slice(b"ftyp");
        avif[8..12].copy_from_slice(b"avif");
        avif[16..20].copy_from_slice(b"ispe");
        avif[24..28].copy_from_slice(&100_u32.to_be_bytes());
        avif[28..32].copy_from_slice(&100_u32.to_be_bytes());

        assert!(inspect_image(&avif).is_err());
    }

    #[test]
    fn oversized_png_canvas_is_rejected_before_browser_decode() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&20_000_u32.to_be_bytes());
        png.extend_from_slice(&20_000_u32.to_be_bytes());

        let error = inspect_image(&png).expect_err("oversized canvas");

        assert!(error.to_string().contains("画布尺寸"));
    }

    #[test]
    fn local_hostname_is_rejected_after_resolution() {
        let url = Url::parse("http://localhost/image.png").expect("url");
        let error = validated_target(&url).expect_err("localhost must be rejected");
        assert!(error.to_string().contains("内网或保留地址"));
    }
}
