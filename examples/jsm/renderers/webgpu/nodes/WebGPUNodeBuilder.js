import WebGPUNodeUniformsGroup from './WebGPUNodeUniformsGroup.js';
import {
	FloatNodeUniform, Vector2NodeUniform, Vector3NodeUniform, Vector4NodeUniform,
	ColorNodeUniform, Matrix3NodeUniform, Matrix4NodeUniform
} from './WebGPUNodeUniform.js';
import WebGPUNodeSampler from './WebGPUNodeSampler.js';
import { WebGPUNodeSampledTexture, WebGPUNodeSampledCubeTexture } from './WebGPUNodeSampledTexture.js';

import WebGPUUniformBuffer from '../WebGPUUniformBuffer.js';
import { getVectorLength, getStrideLength } from '../WebGPUBufferUtils.js';

import NodeBuilder from 'three-nodes/core/NodeBuilder.js';
import WGSLNodeParser from 'three-nodes/parsers/WGSLNodeParser.js';

import CodeNode from 'three-nodes/core/CodeNode.js';

import { NodeMaterial } from 'three-nodes/materials/Materials.js';

const wgslTypeLib = {
	float: 'f32',
	int: 'i32',
	uint: 'u32',
	bool: 'bool',

	vec2: 'vec2<f32>',
	ivec2: 'vec2<i32>',
	uvec2: 'vec2<u32>',
	bvec2: 'vec2<bool>',

	vec3: 'vec3<f32>',
	ivec3: 'vec3<i32>',
	uvec3: 'vec3<u32>',
	bvec3: 'vec3<bool>',

	vec4: 'vec4<f32>',
	ivec4: 'vec4<i32>',
	uvec4: 'vec4<u32>',
	bvec4: 'vec4<bool>',

	mat3: 'mat3x3<f32>',
	imat3: 'mat3x3<i32>',
	umat3: 'mat3x3<u32>',
	bmat3: 'mat3x3<bool>',

	mat4: 'mat4x4<f32>',
	imat4: 'mat4x4<i32>',
	umat4: 'mat4x4<u32>',
	bmat4: 'mat4x4<bool>'
};

const wgslMethods = {
	dFdx: 'dpdx',
	dFdy: 'dpdy'
};

const wgslPolyfill = {
	lessThanEqual: new CodeNode( `
fn lessThanEqual( a : vec3<f32>, b : vec3<f32> ) -> vec3<bool> {

	return vec3<bool>( a.x <= b.x, a.y <= b.y, a.z <= b.z );

}
` ),
	mod: new CodeNode( `
fn mod( x : f32, y : f32 ) -> f32 {

	return x - y * floor( x / y );

}
` ),

	smoothstep: new CodeNode( `
fn smoothstep( low : f32, high : f32, x : f32 ) -> f32 {

	let t = clamp( ( x - low ) / ( high - low ), 0.0, 1.0 );

	return t * t * ( 3.0 - 2.0 * t );

}
` ),
	repeatWrapping: new CodeNode( `
fn repeatWrapping( uv : vec2<f32>, dimension : vec2<i32> ) -> vec2<i32> {

	let uvScaled = vec2<i32>( uv * vec2<f32>( dimension ) );

	return ( ( uvScaled % dimension ) + dimension ) % dimension;

}
` ),
	inversesqrt: new CodeNode( `
fn inversesqrt( x : f32 ) -> f32 {

	return 1.0 / sqrt( x );

}
` )
};

class WebGPUNodeBuilder extends NodeBuilder {

	constructor( object, renderer ) {

		super( object, renderer, new WGSLNodeParser() );

		this.lightNode = null;
		this.fogNode = null;

		this.bindings = { vertex: [], fragment: [] };
		this.bindingsOffset = { vertex: 0, fragment: 0 };

		this.uniformsGroup = {};

	}

	build() {

		NodeMaterial.fromMaterial( this.material ).build( this );

		return super.build();

	}

	addFlowCode( code ) {

		if ( ! /;\s*$/.test( code ) ) {

			code += ';';

		}

		super.addFlowCode( code + '\n\t' );

	}

	getSampler( textureProperty, uvSnippet, shaderStage = this.shaderStage ) {

		if ( shaderStage === 'fragment' ) {

			return `textureSample( ${textureProperty}, ${textureProperty}_sampler, ${uvSnippet} )`;

		} else {

			this._include( 'repeatWrapping' );

			const dimension = `textureDimensions( ${textureProperty}, 0 )`;

			return `textureLoad( ${textureProperty}, repeatWrapping( ${uvSnippet}, ${dimension} ), 0 )`;

		}

	}

	getTexture( textureProperty, uvSnippet, shaderStage = this.shaderStage ) {

		return this.getSampler( textureProperty, uvSnippet, shaderStage );

	}

	getCubeTexture( textureProperty, uvSnippet, shaderStage = this.shaderStage ) {

		return this.getSampler( textureProperty, uvSnippet, shaderStage );

	}

	getPropertyName( node, shaderStage = this.shaderStage ) {

		if ( node.isNodeVary === true ) {

			if ( shaderStage === 'vertex' ) {

				return `NodeVarys.${ node.name }`;

			}

		} else if ( node.isNodeUniform === true ) {

			const name = node.name;
			const type = node.type;

			if ( type === 'texture' || type === 'cubeTexture' ) {

				return name;

			} else if ( type === 'buffer' ) {

				return `NodeBuffer.${name}`;

			} else {

				return `NodeUniforms.${name}`;

			}

		}

		return super.getPropertyName( node );

	}

	getBindings() {

		const bindings = this.bindings;

		return [ ...bindings.vertex, ...bindings.fragment ];

	}

	getUniformFromNode( node, shaderStage, type ) {

		const uniformNode = super.getUniformFromNode( node, shaderStage, type );
		const nodeData = this.getDataFromNode( node, shaderStage );

		if ( nodeData.uniformGPU === undefined ) {

			let uniformGPU;

			const bindings = this.bindings[ shaderStage ];

			if ( type === 'texture' || type === 'cubeTexture' ) {

				const sampler = new WebGPUNodeSampler( `${uniformNode.name}_sampler`, uniformNode.node );

				let texture = null;

				if ( type === 'texture' ) {

					texture = new WebGPUNodeSampledTexture( uniformNode.name, uniformNode.node );

				} else if ( type === 'cubeTexture' ) {

					texture = new WebGPUNodeSampledCubeTexture( uniformNode.name, uniformNode.node );

				}

				// add first textures in sequence and group for last
				const lastBinding = bindings[ bindings.length - 1 ];
				const index = lastBinding && lastBinding.isUniformsGroup ? bindings.length - 1 : bindings.length;

				if ( shaderStage === 'fragment' ) {

					bindings.splice( index, 0, sampler, texture );

					uniformGPU = [ sampler, texture ];

				} else {

					bindings.splice( index, 0, texture );

					uniformGPU = [ texture ];

				}


			} else if ( type === 'buffer' ) {

				const buffer = new WebGPUUniformBuffer( 'NodeBuffer', node.value );

				// add first textures in sequence and group for last
				const lastBinding = bindings[ bindings.length - 1 ];
				const index = lastBinding && lastBinding.isUniformsGroup ? bindings.length - 1 : bindings.length;

				bindings.splice( index, 0, buffer );

				uniformGPU = buffer;

			} else {

				let uniformsGroup = this.uniformsGroup[ shaderStage ];

				if ( uniformsGroup === undefined ) {

					uniformsGroup = new WebGPUNodeUniformsGroup( shaderStage );

					this.uniformsGroup[ shaderStage ] = uniformsGroup;

					bindings.push( uniformsGroup );

				}

				if ( node.isArrayUniformNode === true ) {

					uniformGPU = [];

					for ( const uniformNode of node.nodes ) {

						const uniformNodeGPU = this._getNodeUniform( uniformNode, type );

						// fit bounds to buffer
						uniformNodeGPU.boundary = getVectorLength( uniformNodeGPU.itemSize );
						uniformNodeGPU.itemSize = getStrideLength( uniformNodeGPU.itemSize );

						uniformsGroup.addUniform( uniformNodeGPU );

						uniformGPU.push( uniformNodeGPU );

					}

				} else {

					uniformGPU = this._getNodeUniform( uniformNode, type );

					uniformsGroup.addUniform( uniformGPU );

				}

			}

			nodeData.uniformGPU = uniformGPU;

			if ( shaderStage === 'vertex' ) {

				this.bindingsOffset[ 'fragment' ] = bindings.length;

			}

		}

		return uniformNode;

	}

	isReference( type ) {

		return super.isReference( type ) || type === 'texture_2d' || type === 'texture_cube';

	}

	getAttributes( shaderStage ) {

		let snippet = '';

		if ( shaderStage === 'vertex' ) {

			const attributes = this.attributes;
			const length = attributes.length;

			snippet += '\n';

			for ( let index = 0; index < length; index ++ ) {

				const attribute = attributes[ index ];
				const name = attribute.name;
				const type = this.getType( attribute.type );

				snippet += `\t@location( ${index} ) ${ name } : ${ type }`;

				if ( index + 1 < length ) {

					snippet += ',\n';

				}

			}

			snippet += '\n';

		}

		return snippet;

	}

	getVars( shaderStage ) {

		let snippet = '';

		const vars = this.vars[ shaderStage ];

		for ( let index = 0; index < vars.length; index ++ ) {

			const variable = vars[ index ];

			const name = variable.name;
			const type = this.getType( variable.type );

			snippet += `var ${name} : ${type}; `;

		}

		return snippet;

	}

	getVarys( shaderStage ) {

		let snippet = '';

		if ( shaderStage === 'vertex' ) {

			snippet += '\t@builtin( position ) Vertex: vec4<f32>;\n';

			const varys = this.varys;

			for ( let index = 0; index < varys.length; index ++ ) {

				const vary = varys[ index ];

				snippet += `\t@location( ${index} ) ${ vary.name } : ${ this.getType( vary.type ) };\n`;

			}

			snippet = this._getWGSLStruct( 'NodeVarysStruct', snippet );

		} else if ( shaderStage === 'fragment' ) {

			const varys = this.varys;

			snippet += '\n';

			for ( let index = 0; index < varys.length; index ++ ) {

				const vary = varys[ index ];

				snippet += `\t@location( ${index} ) ${ vary.name } : ${ this.getType( vary.type ) }`;

				if ( index + 1 < varys.length ) {

					snippet += ',\n';

				}

			}

			snippet += '\n';

		}

		return snippet;

	}

	getUniforms( shaderStage ) {

		const uniforms = this.uniforms[ shaderStage ];

		let snippet = '';
		let groupSnippet = '';

		let index = this.bindingsOffset[ shaderStage ];

		for ( const uniform of uniforms ) {

			if ( uniform.type === 'texture' ) {

				if ( shaderStage === 'fragment' ) {

					snippet += `@group( 0 ) @binding( ${index ++} ) var ${uniform.name}_sampler : sampler; `;

				}

				snippet += `@group( 0 ) @binding( ${index ++} ) var ${uniform.name} : texture_2d<f32>; `;

			} else if ( uniform.type === 'cubeTexture' ) {

				if ( shaderStage === 'fragment' ) {

					snippet += `@group( 0 ) @binding( ${index ++} ) var ${uniform.name}_sampler : sampler; `;

				}

				snippet += `@group( 0 ) @binding( ${index ++} ) var ${uniform.name} : texture_cube<f32>; `;

			} else if ( uniform.type === 'buffer' ) {

				const bufferNode = uniform.node;
				const bufferType = this.getType( bufferNode.bufferType );
				const bufferCount = bufferNode.bufferCount;

				const bufferSnippet = `\t${uniform.name} : array< ${bufferType}, ${bufferCount} >;\n`;

				snippet += this._getWGSLUniforms( 'NodeBuffer', bufferSnippet, index ++ ) + '\n\n';

			} else {

				const vectorType = this.getType( this.getVectorType( uniform.type ) );

				if ( Array.isArray( uniform.value ) === true ) {

					const length = uniform.value.length;

					groupSnippet += `uniform ${vectorType}[ ${length} ] ${uniform.name}; `;

				} else {

					groupSnippet += `\t${uniform.name} : ${ vectorType};\n`;

				}

			}

		}

		if ( groupSnippet ) {

			snippet += this._getWGSLUniforms( 'NodeUniforms', groupSnippet, index ++ );

		}

		return snippet;

	}

	buildCode() {

		const shadersData = { fragment: {}, vertex: {} };

		for ( const shaderStage in shadersData ) {

			let flow = '// code\n';
			flow += `\t${ this.flowCode[ shaderStage ] }`;
			flow += '\n';

			const flowNodes = this.flowNodes[ shaderStage ];
			const mainNode = flowNodes[ flowNodes.length - 1 ];

			for ( const node of flowNodes ) {

				const flowSlotData = this.getFlowData( shaderStage, node );
				const slotName = node.name;

				if ( slotName ) {

					if ( flow.length > 0 ) flow += '\n';

					flow += `\t// FLOW -> ${ slotName }\n\t`;

				}

				flow += `${ flowSlotData.code }\n\t`;

				if ( node === mainNode ) {

					flow += '// FLOW RESULT\n\t';

					if ( shaderStage === 'vertex' ) {

						flow += 'NodeVarys.Vertex = ';

					} else if ( shaderStage === 'fragment' ) {

						flow += 'return ';

					}

					flow += `${ flowSlotData.result };`;

				}

			}

			const stageData = shadersData[ shaderStage ];

			stageData.uniforms = this.getUniforms( shaderStage );
			stageData.attributes = this.getAttributes( shaderStage );
			stageData.varys = this.getVarys( shaderStage );
			stageData.vars = this.getVars( shaderStage );
			stageData.codes = this.getCodes( shaderStage );
			stageData.flow = flow;

		}

		this.vertexShader = this._getWGSLVertexCode( shadersData.vertex );
		this.fragmentShader = this._getWGSLFragmentCode( shadersData.fragment );

	}

	getMethod( method ) {

		if ( wgslPolyfill[ method ] !== undefined ) {

			this._include( method );

		}

		return wgslMethods[ method ] || method;

	}

	getType( type ) {

		return wgslTypeLib[ type ] || type;

	}

	_include( name ) {

		wgslPolyfill[ name ].build( this );

	}

	_getNodeUniform( uniformNode, type ) {

		if ( type === 'float' ) return new FloatNodeUniform( uniformNode );
		if ( type === 'vec2' ) return new Vector2NodeUniform( uniformNode );
		if ( type === 'vec3' ) return new Vector3NodeUniform( uniformNode );
		if ( type === 'vec4' ) return new Vector4NodeUniform( uniformNode );
		if ( type === 'color' ) return new ColorNodeUniform( uniformNode );
		if ( type === 'mat3' ) return new Matrix3NodeUniform( uniformNode );
		if ( type === 'mat4' ) return new Matrix4NodeUniform( uniformNode );

		throw new Error( `Uniform "${type}" not declared.` );

	}

	_getWGSLVertexCode( shaderData ) {

		return `${ this.getSignature() }

// uniforms
${shaderData.uniforms}

// varys
${shaderData.varys}

// codes
${shaderData.codes}

@stage( vertex )
fn main( ${shaderData.attributes} ) -> NodeVarysStruct {

	// system
	var NodeVarys: NodeVarysStruct;

	// vars
	${shaderData.vars}

	// flow
	${shaderData.flow}

	return NodeVarys;

}
`;

	}

	_getWGSLFragmentCode( shaderData ) {

		return `${ this.getSignature() }

// uniforms
${shaderData.uniforms}

// codes
${shaderData.codes}

@stage( fragment )
fn main( ${shaderData.varys} ) -> @location( 0 ) vec4<f32> {

	// vars
	${shaderData.vars}

	// flow
	${shaderData.flow}

}
`;

	}

	_getWGSLStruct( name, vars ) {

		return `
struct ${name} {
\n${vars}
};`;

	}

	_getWGSLUniforms( name, vars, binding = 0, group = 0 ) {

		const structName = name + 'Struct';
		const structSnippet = this._getWGSLStruct( structName, vars );

		return `${structSnippet}
@binding( ${binding} ) @group( ${group} )
var<uniform> ${name} : ${structName};`;

	}

}

export default WebGPUNodeBuilder;
